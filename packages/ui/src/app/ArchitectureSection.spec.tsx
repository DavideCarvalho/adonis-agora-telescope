import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { ArchitectureView } from '../client/types.js';
import { ArchitectureSection } from './ArchitectureSection.js';
import { buildLinks, capabilityCovers, layoutGraph, plural } from './architecture-graph.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { formatHash, parseHash } from './use-hash-route.js';
import { TelescopeClientContext } from './use-telescope.js';

beforeAll(() => {
  // React Flow measures its viewport and nodes; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor(_transform?: string) {}
  };
});

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

const view: ArchitectureView = {
  now: NOW,
  windowMs: 3_600_000,
  apps: [
    { id: 'agora-hub', instances: 2, health: 'ok', roles: ['web'], hasClient: true, accepts: null },
    {
      id: 'entre-textos',
      instances: 1,
      health: 'warn',
      roles: ['web', 'queue:work'],
      hasClient: true,
      accepts: ['media:objects:read', 'media:objects:write'],
    },
    { id: 'eduliberta', instances: 1, health: 'ok', roles: ['web'], hasClient: true, accepts: [] },
  ],
  calls: [
    {
      from: 'agora-hub',
      to: 'entre-textos',
      count: 40,
      failed: 0,
      avgMs: 30,
      p95Ms: 80,
      lastAt: NOW,
    },
    {
      from: 'entre-textos',
      to: 'agora-hub',
      count: 10,
      failed: 2,
      avgMs: 15,
      p95Ms: 40,
      lastAt: NOW,
    },
    { from: 'eduliberta', to: 'agora-hub', count: 5, failed: 0, avgMs: 10, p95Ms: 20, lastAt: NOW },
  ],
  grants: [
    {
      from: 'agora-hub',
      to: 'entre-textos',
      capabilities: ['media:objects:read', 'payments:refund'],
      disabled: false,
    },
    {
      from: 'entre-textos',
      to: 'agora-hub',
      capabilities: ['media:avatars:read'],
      disabled: false,
    },
    { from: 'agora-hub', to: 'eduliberta', capabilities: [], disabled: false },
  ],
  sources: { fleet: true, calls: true, grants: true },
  truncated: false,
};

describe('architecture graph model', () => {
  it('reads each link: ok, failing, ungranted, idle; flags grants outside the catalog', () => {
    const links = buildLinks(view, { calls: true, grants: true, infra: true });
    const state = Object.fromEntries(links.map((l) => [l.id, l.state]));
    expect(state).toEqual({
      'agora-hub→eduliberta': 'idle',
      'agora-hub→entre-textos': 'ok',
      'eduliberta→agora-hub': 'ungranted',
      'entre-textos→agora-hub': 'failing',
    });
    expect(links.find((l) => l.id === 'agora-hub→entre-textos')?.outsideCatalog).toEqual([
      'payments:refund',
    ]);
  });

  it('a layer off leaves its links out; without authkit nothing is "ungranted"', () => {
    expect(
      buildLinks(view, { calls: false, grants: true, infra: true }).every((l) => l.call === null),
    ).toBe(true);
    const noAuthkit = buildLinks(
      { ...view, grants: [], sources: { ...view.sources, grants: false } },
      { calls: true, grants: true, infra: true },
    );
    expect(noAuthkit.map((l) => l.state)).not.toContain('ungranted');
  });

  it('apps in a row with the most connected in the middle; backends below their users', () => {
    const links = buildLinks(view, { calls: true, grants: true, infra: true });
    const placed = layoutGraph(
      view.apps,
      links,
      [
        { id: 'postgres:a', tech: 'postgres', label: 'educacao' },
        { id: 'redis:b', tech: 'redis', label: 'main' },
      ],
      [
        { app: 'agora-hub', infra: 'postgres:a', uses: ['app'] },
        { app: 'entre-textos', infra: 'postgres:a', uses: ['app'] },
        { app: 'eduliberta', infra: 'redis:b', uses: ['durable'] },
      ],
    );
    const apps = placed.filter((p) => p.kind === 'app');
    const hub = apps.find((p) => p.kind === 'app' && p.app.id === 'agora-hub');
    expect(hub).toMatchObject({ hub: true });
    const xs = apps.map((p) => p.x).sort((a, b) => a - b);
    expect(hub?.x).toBe(xs[1]);
    const infra = placed.filter((p) => p.kind === 'infra');
    expect(infra.every((p) => p.y > 0)).toBe(true);
    const [a, b] = infra;
    expect(Math.abs((a?.x ?? 0) - (b?.x ?? 0))).toBeGreaterThanOrEqual(190);
  });

  it('pluralizes', () => {
    expect(plural(1, 'capability', 'capabilities')).toBe('1 capability');
    expect(plural(3, 'capability', 'capabilities')).toBe('3 capabilities');
  });

  it('applies the Agora capability rule', () => {
    expect(capabilityCovers('media:*', 'media:objects:read')).toBe(true);
    expect(capabilityCovers('media:objects:read', 'media:objects:write')).toBe(false);
  });
});

function renderPage(data: ArchitectureView) {
  const client = {
    architecture: vi.fn().mockResolvedValue(data),
  } as unknown as TelescopeClient;
  render(
    <TelescopeQueryProvider>
      <NuqsHashAdapter>
        <TelescopeClientContext.Provider value={client}>
          <ArchitectureSection />
        </TelescopeClientContext.Provider>
      </NuqsHashAdapter>
    </TelescopeQueryProvider>,
  );
  return client;
}

describe('Architecture page', () => {
  it('draws the apps, lists the links and opens a link in the details', async () => {
    renderPage(view);
    const list = await waitFor(() => {
      const el = document.querySelector('[data-architecture-links]');
      if (!el) throw new Error('no links yet');
      return el as HTMLElement;
    });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual([
      '● agora-hub → eduliberta',
      '● agora-hub → entre-textos',
      '● eduliberta → agora-hub',
      '● entre-textos → agora-hub',
    ]);
    fireEvent.click(within(list).getByText(/agora-hub → entre-textos/));
    const details = document.querySelector('[data-architecture-details="link"]') as HTMLElement;
    expect(details).not.toBeNull();
    expect(within(details).getByText('payments:refund')).toBeTruthy();
    expect(within(details).getByText(/not in what entre-textos published/)).toBeTruthy();
    expect(document.querySelectorAll('[data-app-node]').length).toBe(3);
  });

  it('says which layers are missing', async () => {
    renderPage({ ...view, sources: { fleet: false, calls: true, grants: false }, truncated: true });
    const notices = await waitFor(() => {
      const el = document.querySelector('[data-architecture-notices]');
      if (!el) throw new Error('no notices yet');
      return el as HTMLElement;
    });
    expect(notices.textContent).toMatch(/authkit does not run/);
    expect(notices.textContent).toMatch(/no fleet here/);
    expect(notices.textContent).toMatch(/scan cap/);
  });

  it('asks the server for the picked window', async () => {
    const client = renderPage(view);
    await waitFor(() => expect(client.architecture).toHaveBeenCalledWith('1h'));
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await waitFor(() => expect(client.architecture).toHaveBeenCalledWith('24h'));
  });

  it('has a route', () => {
    expect(parseHash(formatHash({ name: 'architecture' }))).toEqual({ name: 'architecture' });
  });
});
