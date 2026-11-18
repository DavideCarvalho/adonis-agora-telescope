import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { ScreenStats, TelescopeMeta } from '../client/types.js';
import { EntriesSection } from './EntriesSection.js';
import { ExportsSection } from './ExportsSection.js';
import { entryTypeOptions } from './entry-type-options.js';
import { ProfilesSection, screenRouteOptions } from './ProfilesSection.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

afterEach(cleanup);

const emptyPage = {
  data: [],
  meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
};

function screenRow(url: string, count: number): ScreenStats {
  return {
    url,
    kind: 'page',
    count,
    users: 1,
    avgMs: 10,
    maxMs: 20,
    errors: 0,
    lastAt: '2026-11-18T10:00:00.000Z',
  };
}

function fakeClient(meta: Partial<TelescopeMeta>, overrides: Record<string, unknown> = {}) {
  return {
    listEntriesPage: vi.fn().mockResolvedValue(emptyPage),
    listEntries: vi.fn().mockResolvedValue([]),
    apps: vi.fn().mockResolvedValue([]),
    tenants: vi.fn().mockResolvedValue([]),
    streamUrl: vi.fn().mockReturnValue('/telescope/api/stream'),
    meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards: [], ...meta }),
    ...overrides,
  } as unknown as TelescopeClient;
}

function renderWith(client: TelescopeClient, ui: ReactNode) {
  return render(
    <TelescopeQueryProvider>
      <NuqsHashAdapter>
        <TelescopeClientContext.Provider value={client}>{ui}</TelescopeClientContext.Provider>
      </NuqsHashAdapter>
    </TelescopeQueryProvider>,
  );
}

async function type(input: HTMLElement, text: string) {
  await act(async () => {
    input.focus();
    // Base UI opens the popup on ArrowDown, not on input events.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: text } });
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function pick(name: RegExp | string) {
  const option = await screen.findByRole('option', { name });
  await act(async () => {
    fireEvent.click(option);
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('entryTypeOptions', () => {
  it('marks built-in types whose watcher is off, and appends extension types', () => {
    const options = entryTypeOptions({
      entryTypes: [{ id: 'billing', label: 'Billing', dot: '#fff' }],
      dashboards: [],
      watchers: ['request', 'logs'],
    });
    const byValue = new Map(options.map((o) => [o.value, o]));
    expect(byValue.get('request')?.hint).toBeUndefined();
    expect(byValue.get('log')?.hint).toBeUndefined();
    expect(byValue.get('query')?.hint).toBe('watcher off');
    expect(byValue.get('job')?.hint).toBe('watcher off');
    // Not gated by one watcher: never marked.
    expect(byValue.get('exception')?.hint).toBeUndefined();
    expect(byValue.get('http-client')?.label).toBe('HTTP client');
    expect(options.at(-1)).toEqual({ value: 'billing', label: 'Billing' });
  });

  it('marks nothing when /meta does not say which watchers run', () => {
    const options = entryTypeOptions({ entryTypes: [], dashboards: [], watchers: null });
    expect(options.some((o) => o.hint !== undefined)).toBe(false);
  });
});

describe('Entries type filter', () => {
  it('filters the type list as you type and writes the pick to the URL', async () => {
    window.history.replaceState(null, '', '/telescope#/entries');
    const client = fakeClient({ watchers: ['request'] });
    renderWith(client, <EntriesSection onOpenEntry={vi.fn()} onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(client.meta).toHaveBeenCalled());

    await type(screen.getByRole('combobox', { name: 'filter by type' }), 'quer');
    expect(screen.queryByRole('option', { name: /^request/ })).toBeNull();
    // `query`'s watcher isn't running: the option says so.
    expect((await screen.findByRole('option', { name: /query/ })).textContent).toContain(
      'watcher off',
    );
    await pick(/query/);
    await waitFor(() => expect(window.location.hash).toBe('#/entries?type=query'));
    await waitFor(() =>
      expect(
        (client.listEntriesPage as ReturnType<typeof vi.fn>).mock.calls.some(
          (call) => (call[0] as { type?: string }).type === 'query',
        ),
      ).toBe(true),
    );
  });

  it('shows the type from a shared link in the field', async () => {
    window.history.replaceState(null, '', '/telescope#/entries?type=mail');
    renderWith(fakeClient({}), <EntriesSection onOpenEntry={vi.fn()} onOpenTrace={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: 'filter by type' }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('mail'));
  });
});

describe('Exports type field', () => {
  it('writes the picked type to the URL', async () => {
    window.history.replaceState(null, '', '/telescope#/exports');
    renderWith(fakeClient({}), <ExportsSection />);
    await type(screen.getByRole('combobox', { name: 'export type' }), 'redis');
    await pick(/redis/);
    await waitFor(() => expect(window.location.hash).toBe('#/exports?type=redis'));
  });
});

describe('Profiles route to capture', () => {
  it('suggests visited pages busiest first, deduplicated', () => {
    expect(
      screenRouteOptions([screenRow('/a', 1), screenRow('/b', 9), screenRow('/b', 2)]).map(
        (o) => o.value,
      ),
    ).toEqual(['GET /b', 'GET /a']);
  });

  function profilesClient() {
    return fakeClient(
      { profiling: { enabled: true } },
      {
        profilerStatus: vi
          .fn()
          .mockResolvedValue({ enabled: true, sampleRate: 0, active: 0, pendingManual: 0 }),
        profiles: vi.fn().mockResolvedValue([]),
        profile: vi.fn().mockResolvedValue(null),
        screens: vi.fn().mockResolvedValue([screenRow('/dashboard', 12)]),
        armProfile: vi.fn().mockResolvedValue({ ok: true, pendingManual: 1 }),
      },
    );
  }

  it('arms a capture for a suggested route', async () => {
    window.history.replaceState(null, '', '/telescope#/profiles');
    const client = profilesClient();
    renderWith(client, <ProfilesSection />);
    const input = await screen.findByRole('combobox', { name: 'route to capture' });
    await waitFor(() => expect(client.screens).toHaveBeenCalledWith(3_600_000, 'page', 100));
    await type(input, 'dash');
    await pick(/GET \/dashboard/);
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }));
    await waitFor(() => expect(client.armProfile).toHaveBeenCalledWith(1, 'GET /dashboard'));
  });

  it('arms a capture for a typed route pattern', async () => {
    window.history.replaceState(null, '', '/telescope#/profiles');
    const client = profilesClient();
    renderWith(client, <ProfilesSection />);
    const input = await screen.findByRole('combobox', { name: 'route to capture' });
    await type(input, 'GET /users/:id');
    await pick(/Use “GET \/users\/:id”/);
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }));
    await waitFor(() => expect(client.armProfile).toHaveBeenCalledWith(1, 'GET /users/:id'));
  });
});
