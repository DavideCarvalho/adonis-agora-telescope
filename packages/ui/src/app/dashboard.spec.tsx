import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type {
  Entry,
  EntrySummary,
  PulseSummary,
  StatsResult,
  TraceSummary,
} from '../client/types.js';
import { EntriesSection } from './EntriesSection.js';
import { EntryDetail } from './EntryDetail.js';
import { ExceptionsSection } from './ExceptionsSection.js';
import { PulseSection } from './PulseSection.js';
import { TraceDetail } from './TraceDetail.js';
import { TracesSection } from './TracesSection.js';
import {
  EventSourceFactoryContext,
  type EventSourceLike,
  TelescopeClientContext,
} from './use-telescope.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const entrySummary: EntrySummary = {
  id: 'e-1',
  type: 'request',
  familyHash: 'req:GET:/users',
  tags: ['status:200'],
  traceId: 'trace-abc123',
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
    traceId: 'trace-abc123',
    user: { id: '42', email: 'ada@example.com' },
  },
  tags: ['status:200'],
  sequence: 1,
  durationMs: 42,
  origin: 'http',
  traceId: 'trace-abc123',
  createdAt: '2026-07-13T10:00:00.000Z',
};

const traceSummary: TraceSummary = {
  traceId: 'trace-abc123',
  entryCount: 3,
  types: ['request', 'query'],
  firstAt: '2026-07-13T10:00:00.000Z',
  lastAt: '2026-07-13T10:00:00.500Z',
  totalDurationMs: 120,
  rootLabel: 'GET /users',
};

const pulseSummary: PulseSummary = {
  windowStart: '2026-07-13T09:00:00.000Z',
  windowEnd: '2026-07-13T10:00:00.000Z',
  windowMs: 3_600_000,
  counts: { request: 10, query: 20 },
  throughput: {
    total: 30,
    perMinute: 0.5,
    overTime: {
      windowStart: '',
      windowEnd: '',
      bucketMs: 60000,
      buckets: [{ t: '', total: 5, byType: {} }],
    },
  },
  requests: {
    total: 10,
    errorRate: 0.1,
    status: { '2xx': 8, '3xx': 0, '4xx': 1, '5xx': 1, other: 0 },
    latency: { count: 10, p50: 12, p95: 80, p99: 120, max: 200, slow: 2 },
  },
  slowest: [
    { id: 'e-1', type: 'request', durationMs: 200, label: 'GET /slow', traceId: 'trace-abc123' },
  ],
  slowRoutes: [{ route: 'GET /slow', count: 3, p99: 180, p50: 90 }],
  slowOutgoing: [],
  slowJobs: [],
  topExceptions: [
    {
      key: 'k1',
      class: 'TypeError',
      message: 'boom',
      count: 4,
      lastSeen: '2026-07-13T10:00:00.000Z',
    },
  ],
  nPlusOne: [],
  loadByUser: [{ user: '42', count: 5, totalDurationMs: 300 }],
  scanned: 30,
  truncated: false,
};

const exceptionStats: StatsResult = {
  type: 'exception',
  windowMs: 3_600_000,
  total: 4,
  overTime: { windowStart: '', windowEnd: '', bucketMs: 60000, buckets: [] },
  exceptions: [
    {
      key: 'k1',
      class: 'ValidationError',
      message: 'email is required',
      count: 4,
      lastAt: '2026-07-13T10:00:00.000Z',
      overTime: [1, 2, 1, 0],
    },
  ],
  truncated: false,
};

function fakeClient(overrides: Partial<TelescopeClient> = {}): TelescopeClient {
  return {
    listEntries: vi.fn().mockResolvedValue([entrySummary]),
    getEntry: vi.fn().mockResolvedValue(fullEntry),
    entriesByTrace: vi.fn().mockResolvedValue([entrySummary]),
    traces: vi.fn().mockResolvedValue([traceSummary]),
    waterfall: vi.fn().mockResolvedValue({ traceStartMs: 0, totalDurationMs: 120, spans: [] }),
    nPlusOne: vi.fn().mockResolvedValue([]),
    pulse: vi.fn().mockResolvedValue(pulseSummary),
    metricsStats: vi.fn().mockResolvedValue(exceptionStats),
    streamUrl: vi.fn().mockReturnValue('/telescope/api/stream'),
    // `EntryDetail` reads `meta.ai.enabled` to gate the AI diagnosis panel — defaulted to disabled
    // so the existing EntryDetail assertions below don't need to know about the AI panel at all.
    meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards: [], ai: { enabled: false } }),
    ...overrides,
  } as unknown as TelescopeClient;
}

// A controllable EventSource stand-in for the live-tail test.
class FakeEventSource implements EventSourceLike {
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const list = this.listeners[type] ?? [];
    list.push(cb);
    this.listeners[type] = list;
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data });
  }
}

function renderWith(
  client: TelescopeClient,
  ui: ReactNode,
  esFactory?: (url: string) => EventSourceLike,
) {
  const tree = (
    <TelescopeClientContext.Provider value={client}>{ui}</TelescopeClientContext.Provider>
  );
  return render(
    <StrictMode>
      {esFactory ? (
        <EventSourceFactoryContext.Provider value={esFactory}>
          {tree}
        </EventSourceFactoryContext.Provider>
      ) : (
        tree
      )}
    </StrictMode>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('EntriesSection', () => {
  it('lists entries from the /entries route and opens an entry on row click', async () => {
    const client = fakeClient();
    const onOpenEntry = vi.fn();
    renderWith(client, <EntriesSection onOpenEntry={onOpenEntry} onOpenTrace={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('GET /users → 200')).toBeTruthy());
    expect(client.listEntries).toHaveBeenCalled();

    fireEvent.click(screen.getByText('GET /users → 200'));
    expect(onOpenEntry).toHaveBeenCalledWith('e-1');
  });

  it('prepends a live entry from the SSE stream when live tail is on', async () => {
    const client = fakeClient({ listEntries: vi.fn().mockResolvedValue([]) });
    let source: FakeEventSource | null = null;
    const factory = () => {
      source = new FakeEventSource();
      return source;
    };
    renderWith(client, <EntriesSection onOpenEntry={vi.fn()} onOpenTrace={vi.fn()} />, factory);

    await waitFor(() => expect(screen.getByText('No entries match these filters.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /live tail/i }));
    await waitFor(() => expect(source).not.toBeNull());

    const live = { ...entrySummary, id: 'live-1', summary: 'POST /orders → 201' };
    act(() => source?.emit('entry', JSON.stringify(live)));

    await waitFor(() => expect(screen.getByText('POST /orders → 201')).toBeTruthy());
  });

  it('shows an empty state when nothing matches', async () => {
    const client = fakeClient({ listEntries: vi.fn().mockResolvedValue([]) });
    renderWith(client, <EntriesSection onOpenEntry={vi.fn()} onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No entries match these filters.')).toBeTruthy());
  });
});

describe('EntryDetail', () => {
  it('renders the entry content and metadata from /entries/:id', async () => {
    const client = fakeClient();
    renderWith(client, <EntryDetail id="e-1" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    expect(client.getEntry).toHaveBeenCalledWith('e-1');
    expect(screen.getByText('e-1')).toBeTruthy();
    expect(screen.getByText(/view trace/)).toBeTruthy();
  });

  it('shows the authenticated user for a request entry', async () => {
    const client = fakeClient();
    renderWith(client, <EntryDetail id="e-1" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/users')).toBeTruthy());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
  });
});

describe('EntryDetail — AI diagnosis', () => {
  const exceptionEntry: Entry = {
    id: 'e-2',
    type: 'exception',
    familyHash: 'exc:TypeError:boom',
    content: { name: 'TypeError', message: 'boom', stack: 'at foo (a.ts:1:1)' },
    tags: [],
    sequence: 2,
    durationMs: null,
    origin: 'manual',
    traceId: null,
    createdAt: '2026-07-13T10:00:00.000Z',
  };

  it('hides the panel when meta.ai.enabled is false', async () => {
    const client = fakeClient({ getEntry: vi.fn().mockResolvedValue(exceptionEntry) });
    renderWith(client, <EntryDetail id="e-2" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('e-2')).toBeTruthy());
    expect(screen.queryByText('Diagnose with AI')).toBeNull();
  });

  it('runs a diagnosis on click and renders the markdown result', async () => {
    const diagnoseException = vi.fn().mockResolvedValue({
      ok: true,
      markdown: '## Probable cause\n\nA null was dereferenced.',
      cached: false,
    });
    const client = fakeClient({
      getEntry: vi.fn().mockResolvedValue(exceptionEntry),
      meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards: [], ai: { enabled: true } }),
      diagnoseException,
    });
    renderWith(client, <EntryDetail id="e-2" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Diagnose with AI')).toBeTruthy());

    fireEvent.click(screen.getByText('Diagnose with AI'));
    expect(diagnoseException).toHaveBeenCalledWith('e-2', false);
    await waitFor(() => expect(screen.getByText('A null was dereferenced.')).toBeTruthy());
    expect(screen.getByText('Re-run')).toBeTruthy();

    fireEvent.click(screen.getByText('Re-run'));
    expect(diagnoseException).toHaveBeenCalledWith('e-2', true);
  });

  it('renders the failure message when diagnosis is unavailable', async () => {
    const client = fakeClient({
      getEntry: vi.fn().mockResolvedValue(exceptionEntry),
      meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards: [], ai: { enabled: true } }),
      diagnoseException: vi
        .fn()
        .mockResolvedValue({ ok: false, message: 'AI diagnosis failed or timed out.' }),
    });
    renderWith(client, <EntryDetail id="e-2" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Diagnose with AI')).toBeTruthy());
    fireEvent.click(screen.getByText('Diagnose with AI'));
    await waitFor(() => expect(screen.getByText('AI diagnosis failed or timed out.')).toBeTruthy());
  });
});

describe('EntryDetail — replay', () => {
  it('replays a request entry and renders the outcome', async () => {
    const replayRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, durationMs: 12, body: 'ok' });
    const client = fakeClient({ replayRequest });
    renderWith(client, <EntryDetail id="e-1" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Replay request')).toBeTruthy());

    fireEvent.click(screen.getByText('Replay request'));
    expect(replayRequest).toHaveBeenCalledWith('e-1');
    await waitFor(() => expect(screen.getByText('200')).toBeTruthy());
    expect(screen.getByText('12ms')).toBeTruthy();
  });

  it('renders the failure message when replay is disabled', async () => {
    const client = fakeClient({
      replayRequest: vi
        .fn()
        .mockResolvedValue({ ok: false, message: 'Request replay is disabled.' }),
    });
    renderWith(client, <EntryDetail id="e-1" onOpenTrace={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Replay request')).toBeTruthy());
    fireEvent.click(screen.getByText('Replay request'));
    await waitFor(() => expect(screen.getByText('Request replay is disabled.')).toBeTruthy());
  });
});

describe('PulseSection', () => {
  it('renders the health rollup from /metrics/pulse', async () => {
    const client = fakeClient();
    renderWith(client, <PulseSection onOpenTrace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Pulse · health overview')).toBeTruthy());
    expect(client.pulse).toHaveBeenCalled();
    // Error rate 0.1 → 10.0%, and a slow-route + top-exception surface.
    expect(screen.getByText('10.0%')).toBeTruthy();
    // 'GET /slow' surfaces in both the Slowest and Slow-routes cards.
    expect(screen.getAllByText('GET /slow').length).toBeGreaterThan(0);
    expect(screen.getByText(/TypeError: boom/)).toBeTruthy();
  });
});

describe('ExceptionsSection', () => {
  it('groups exceptions from /metrics/stats?type=exception', async () => {
    const client = fakeClient();
    renderWith(client, <ExceptionsSection onOpenType={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('ValidationError')).toBeTruthy());
    expect(client.metricsStats).toHaveBeenCalledWith('exception', 3_600_000);
    expect(screen.getByText('email is required')).toBeTruthy();
  });
});

describe('TraceDetail', () => {
  it('shows the request entry user in the trace header', async () => {
    const client = fakeClient({
      entriesByTrace: vi.fn().mockResolvedValue([
        { ...entrySummary, type: 'request', userLabel: 'ada@example.com' },
        { ...entrySummary, id: 'q-1', type: 'query', summary: 'select 1', userLabel: undefined },
      ]),
    });
    renderWith(
      client,
      <TraceDetail traceId="trace-abc123" onOpenEntry={vi.fn()} onBack={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText(/ada@example\.com/)).toBeTruthy());
  });
});

describe('TracesSection', () => {
  it('lists traces from /metrics/traces', async () => {
    const client = fakeClient();
    const onOpenTrace = vi.fn();
    renderWith(client, <TracesSection onOpenTrace={onOpenTrace} />);
    await waitFor(() => expect(screen.getByText('GET /users')).toBeTruthy());
    expect(client.traces).toHaveBeenCalled();
    fireEvent.click(screen.getByText('GET /users'));
    expect(onOpenTrace).toHaveBeenCalledWith('trace-abc123');
  });
});
