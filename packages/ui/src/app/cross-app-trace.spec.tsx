import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { TraceSummary, Waterfall } from '../client/types.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { hiddenSpansNote, TraceDetail, waterfallShowsApps } from './TraceDetail.js';
import { TracesSection } from './TracesSection.js';
import { TelescopeClientContext } from './use-telescope.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const span = (id: string, label: string, depth: number, app?: string) => ({
  id,
  type: 'request',
  label,
  offsetMs: depth * 10,
  durationMs: 50,
  depth,
  sequence: depth,
  ...(app !== undefined ? { app } : {}),
  children: [],
});

const crossApp: Waterfall = {
  traceStartMs: 0,
  totalDurationMs: 100,
  apps: ['shop', 'billing'],
  spans: [
    {
      ...span('1', 'GET /checkout', 0, 'shop'),
      children: [span('2', 'GET /charge', 1, 'billing')],
    },
  ],
};

function client(overrides: Partial<Record<keyof TelescopeClient, unknown>> = {}) {
  return {
    entriesByTrace: vi.fn().mockResolvedValue([]),
    waterfall: vi.fn().mockResolvedValue(crossApp),
    nPlusOne: vi.fn().mockResolvedValue([]),
    apps: vi.fn().mockResolvedValue({
      enabled: true,
      all: true,
      apps: [
        { id: 'shop', label: 'Shop' },
        { id: 'billing', label: 'Billing' },
      ],
    }),
    tracesPage: vi.fn(),
    ...overrides,
  } as unknown as TelescopeClient;
}

function renderWith(c: TelescopeClient, ui: ReactNode) {
  return render(
    <TelescopeQueryProvider>
      <NuqsHashAdapter>
        <TelescopeClientContext.Provider value={c}>{ui}</TelescopeClientContext.Provider>
      </NuqsHashAdapter>
    </TelescopeQueryProvider>,
  );
}

describe('cross-app waterfall', () => {
  it('one waterfall with an app per span, labelled', async () => {
    const { container } = renderWith(
      client(),
      <TraceDetail traceId="t" onOpenEntry={vi.fn()} onBack={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('GET /charge')).toBeTruthy());
    const apps = [...container.querySelectorAll('.wf-app')].map((el) => el.textContent);
    expect(apps).toEqual(['Shop', 'Billing']);
    expect(screen.getByTestId('waterfall-apps').textContent).toContain('Shop → Billing');
    expect(container.querySelector('.waterfall-apps')).not.toBeNull();
  });

  it('a single app: no app column', async () => {
    const single: Waterfall = {
      traceStartMs: 0,
      totalDurationMs: 50,
      spans: [span('1', 'GET /users', 0)],
    };
    const { container } = renderWith(
      client({ waterfall: vi.fn().mockResolvedValue(single) }),
      <TraceDetail traceId="t" onOpenEntry={vi.fn()} onBack={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('GET /users')).toBeTruthy());
    expect(container.querySelector('.wf-app')).toBeNull();
    expect(screen.queryByTestId('waterfall-apps')).toBeNull();
  });

  it('a viewer limited to one app sees the hidden-spans note', async () => {
    const limited: Waterfall = {
      traceStartMs: 0,
      totalDurationMs: 50,
      apps: ['shop'],
      hiddenSpans: 3,
      spans: [span('1', 'GET /checkout', 0, 'shop')],
    };
    renderWith(
      client({ waterfall: vi.fn().mockResolvedValue(limited) }),
      <TraceDetail traceId="t" onOpenEntry={vi.fn()} onBack={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('3 spans in other apps hidden')).toBeTruthy());
  });

  it('helpers', () => {
    expect(waterfallShowsApps(crossApp)).toBe(true);
    expect(waterfallShowsApps({ ...crossApp, apps: ['shop'] })).toBe(false);
    expect(waterfallShowsApps({ traceStartMs: 0, totalDurationMs: 0, spans: [] })).toBe(false);
    expect(hiddenSpansNote({ ...crossApp, hiddenSpans: 1 })).toBe('1 span in other apps hidden');
    expect(hiddenSpansNote(crossApp)).toBeNull();
  });
});

describe('trace list', () => {
  const row: TraceSummary = {
    traceId: 'trace-1',
    entryCount: 4,
    types: ['request'],
    firstAt: new Date().toISOString(),
    lastAt: new Date().toISOString(),
    totalDurationMs: 90,
    rootLabel: 'GET /checkout',
  };
  const page = (data: TraceSummary[]) =>
    vi.fn().mockResolvedValue({
      data,
      meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
    });

  it('shows the apps a trace crossed', async () => {
    renderWith(
      client({ tracesPage: page([{ ...row, apps: ['shop', 'billing'] }]) }),
      <TracesSection onOpenTrace={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('Shop → Billing')).toBeTruthy());
    expect(screen.getByText('Apps')).toBeTruthy();
  });

  it('the Apps column stays on a multi-app server even when this page is single-app', async () => {
    renderWith(client({ tracesPage: page([row]) }), <TracesSection onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Apps')).toBeTruthy());
  });

  it('no Apps column for a single app', async () => {
    const standalone = vi.fn().mockResolvedValue({ enabled: false, all: true, apps: [] });
    renderWith(
      client({ tracesPage: page([row]), apps: standalone }),
      <TracesSection onOpenTrace={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('GET /checkout')).toBeTruthy());
    expect(screen.queryByText('Apps')).toBeNull();
  });
});
