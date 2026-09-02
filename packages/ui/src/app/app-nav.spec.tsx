import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type {
  Entry,
  EntrySummary,
  PulseSummary,
  RetentionInfo,
  TimeseriesReport,
  TraceSummary,
  Waterfall,
} from '../client/types.js';
import { App } from './App.js';
import { TelescopeClientContext } from './use-telescope.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const entrySummary: EntrySummary = {
  id: 'e-1',
  type: 'request',
  familyHash: 'req:GET:/users',
  tags: [],
  traceId: 'trace-abc',
  durationMs: 42,
  sequence: 1,
  createdAt: '2026-07-13T10:00:00.000Z',
  summary: 'GET /users → 200',
  userLabel: 'ada@example.com',
};

const fullEntry: Entry = {
  id: 'e-1',
  type: 'request',
  familyHash: 'req:GET:/users',
  content: {
    method: 'GET',
    url: '/users',
    status: 200,
    durationMs: 42,
    traceId: 'trace-abc',
    user: { id: '42', email: 'ada@example.com' },
  },
  tags: [],
  sequence: 1,
  durationMs: 42,
  origin: 'http',
  traceId: 'trace-abc',
  createdAt: '2026-07-13T10:00:00.000Z',
};

const traceSummary: TraceSummary = {
  traceId: 'trace-abc',
  entryCount: 1,
  types: ['request'],
  firstAt: '2026-07-13T10:00:00.000Z',
  lastAt: '2026-07-13T10:00:00.100Z',
  totalDurationMs: 42,
  rootLabel: 'GET /users',
};

const waterfallWithEntry: Waterfall = {
  traceStartMs: 0,
  totalDurationMs: 42,
  spans: [
    {
      id: 'e-1',
      type: 'request',
      label: 'GET /users',
      offsetMs: 0,
      durationMs: 42,
      depth: 0,
      sequence: 1,
      children: [],
    },
  ],
};

const emptyTimeseries: TimeseriesReport = {
  windowStart: '',
  windowEnd: '',
  bucketMs: 60000,
  buckets: [],
};

// A minimal-but-valid pulse: the Overview renders this on the default landing route.
const minimalPulse: PulseSummary = {
  windowStart: '2026-07-13T09:00:00.000Z',
  windowEnd: '2026-07-13T10:00:00.000Z',
  windowMs: 3_600_000,
  counts: {},
  throughput: { total: 0, perMinute: 0, overTime: emptyTimeseries },
  requests: {
    total: 0,
    errorRate: 0,
    status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
  },
  slowest: [],
  slowRoutes: [],
  slowOutgoing: [],
  slowJobs: [],
  topExceptions: [],
  nPlusOne: [],
  loadByUser: [],
  scanned: 0,
  truncated: false,
};

const minimalRetention: RetentionInfo = {
  enabled: false,
  afterMs: 0,
  keepLast: null,
  intervalMs: 0,
  sampling: [],
};

// The shell boots every section the test visits, so the fake satisfies every endpoint `<App />`
// (and the views it navigates to) calls: Overview's pulse/timeseries/queues/retention, the header's
// retention, Entries' listEntries, EntryDetail's getEntry, TraceDetail's entriesByTrace/waterfall,
// plus the harmless live-tail/SSE and panel-action methods a request entry's detail would render.
function fakeClient(overrides: Partial<TelescopeClient> = {}): TelescopeClient {
  return {
    meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards: [], ai: { enabled: false } }),
    retention: vi.fn().mockResolvedValue(minimalRetention),
    pulse: vi.fn().mockResolvedValue(minimalPulse),
    metricsTimeseries: vi.fn().mockResolvedValue(emptyTimeseries),
    liveQueues: vi.fn().mockResolvedValue({
      queues: [],
      capabilities: { mutationsEnabled: false, actions: [] },
    }),
    traces: vi.fn().mockResolvedValue([traceSummary]),
    listEntries: vi.fn().mockResolvedValue([entrySummary]),
    listEntriesPage: vi
      .fn()
      .mockResolvedValue({ rows: [entrySummary], page: 1, hasMore: false }),
    getEntry: vi.fn().mockResolvedValue(fullEntry),
    entriesByTrace: vi.fn().mockResolvedValue([entrySummary]),
    waterfall: vi.fn().mockResolvedValue({ traceStartMs: 0, totalDurationMs: 0, spans: [] }),
    nPlusOne: vi.fn().mockResolvedValue([]),
    metricsStats: vi.fn().mockResolvedValue({
      type: 'exception',
      windowMs: 3_600_000,
      total: 0,
      overTime: emptyTimeseries,
      truncated: false,
    }),
    streamUrl: vi.fn().mockReturnValue('/telescope/api/stream'),
    liveSchedules: vi.fn().mockResolvedValue({ tasks: [] }),
    profilerStatus: vi.fn().mockResolvedValue(null),
    profiles: vi.fn().mockResolvedValue([]),
    profile: vi.fn().mockResolvedValue(fullEntry),
    armProfile: vi.fn().mockResolvedValue({ ok: true, pendingManual: 0 }),
    diagnoseException: vi.fn().mockResolvedValue({ ok: true, markdown: '', cached: false }),
    replayRequest: vi.fn().mockResolvedValue({ ok: true, status: 200, durationMs: 0, body: '' }),
    ...overrides,
  } as unknown as TelescopeClient;
}

function renderApp(client: TelescopeClient): void {
  render(
    <StrictMode>
      <TelescopeClientContext.Provider value={client}>
        <App />
      </TelescopeClientContext.Provider>
    </StrictMode>,
  );
}

// jsdom: `window.location.hash` works, but setting it never auto-fires `hashchange`, and
// `history.back()` restores the previous hash on a queued task (not synchronously). The tests
// therefore drive route changes explicitly: set the hash + dispatch `hashchange` inside `act`.
const goto = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

// Every test (and the in-app Back button) mutates the hash, and jsdom pushes a history entry on
// every hash write — so the length accumulates across the file. The fallback test below relies on
// `history.length` starting at its jsdom minimum (1) on a fresh page, so it must run FIRST and the
// reset must be a no-op when the hash is already empty (which is also the only way the first test
// keeps `history.length === 1`).
beforeEach(() => {
  vi.clearAllMocks();
  if (window.location.hash !== '') window.location.hash = '';
});

describe('App shell navigation', () => {
  // MUST stay the first test in this file: it asserts the fallback branch of the in-app Back, which
  // requires `window.history.length === 1` — only true on a fresh jsdom page before any hash write.
  it('falls back to the section when there is no browser history to go back to', async () => {
    expect(window.history.length).toBe(1);

    // Deep-link onto an entry WITHOUT pushing a history entry (`replaceState`), so the detail view
    // renders but the Back button still has no previous entry to return to.
    act(() => {
      window.history.replaceState(null, '', '#/entries/e-1');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.history.length).toBe(1);

    renderApp(fakeClient());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to entries/i })).toBeTruthy(),
    );
    expect(screen.getByText('Content')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /back to entries/i }));
    expect(window.location.hash).toBe('#/entries');
  });

  it('lands on #/overview and navigates sections + watchers from the sidebar', async () => {
    renderApp(fakeClient());

    await waitFor(() => expect(window.location.hash).toBe('#/overview'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy());

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'sections' })).getByRole('button', {
        name: 'Entries',
      }),
    );
    expect(window.location.hash).toBe('#/entries');
    goto('#/entries');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /filter by type/i })).toBeTruthy(),
    );

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'watchers' })).getByRole('button', {
        name: 'exception',
      }),
    );
    expect(window.location.hash).toBe('#/entries?type=exception');
    goto('#/entries?type=exception');
    await waitFor(() => expect(screen.getByText(/type: exception/i)).toBeTruthy());
  });

  it('deep-links into an entry detail and back to the entries list', async () => {
    window.location.hash = '#/entries/exception-1';
    renderApp(fakeClient());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to entries/i })).toBeTruthy(),
    );
    expect(screen.getByText('Content')).toBeTruthy();
    expect(screen.getByText('e-1')).toBeTruthy();

    goto('#/entries');
    await waitFor(() => expect(screen.getByText('GET /users → 200')).toBeTruthy());
  });

  it('preserves the originating trace when an entry opened from a trace goes Back', async () => {
    const client = fakeClient({ waterfall: vi.fn().mockResolvedValue(waterfallWithEntry) });
    window.location.hash = '#/traces/trace-abc';
    renderApp(client);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to traces/i })).toBeTruthy(),
    );
    await waitFor(() => expect(client.waterfall).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /GET \/users/i }));
    expect(window.location.hash).toBe('#/entries/e-1');
    goto('#/entries/e-1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to entries/i })).toBeTruthy(),
    );
    expect(screen.getByText('Content')).toBeTruthy();

    const preBack = window.location.hash;
    fireEvent.click(screen.getByRole('button', { name: /back to entries/i }));
    expect(preBack).toBe('#/entries/e-1');

    // `goBack` prefers browser history: `history.length > 1`, so it calls `history.back()`. In
    // jsdom that restores the previous hash asynchronously and does NOT fire `hashchange`, so wait
    // for the URL truth and then dispatch the hashchange to let the shell re-render the trace view.
    await waitFor(() => expect(window.location.hash).toBe('#/traces/trace-abc'));
    goto('#/traces/trace-abc');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to traces/i })).toBeTruthy(),
    );
  });
});
