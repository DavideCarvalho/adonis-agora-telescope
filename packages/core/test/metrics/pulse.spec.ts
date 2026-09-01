import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryType } from '../../src/entry.js';
import type { PulseOptions } from '../../src/metrics/pulse.js';
import { PulseService, summarizePulse } from '../../src/metrics/pulse.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

const HOUR = 3_600_000;

/** Record a request entry with an explicit status/duration/route family. */
async function request(
  store: InMemoryTelescopeStore,
  opts: {
    status: number;
    durationMs: number;
    familyHash?: string;
    url?: string;
    method?: string;
    user?: string;
  },
): Promise<void> {
  await store.record({
    type: EntryType.Request,
    ...(opts.familyHash !== undefined ? { familyHash: opts.familyHash } : {}),
    content: { method: opts.method ?? 'GET', url: opts.url ?? '/x', status: opts.status },
    durationMs: opts.durationMs,
    tags: [`status:${opts.status}`, ...(opts.user !== undefined ? [`user:${opts.user}`] : [])],
  });
}

describe('PulseService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates counts, slowest, error rate, throughput and top exceptions', async () => {
    const store = new InMemoryTelescopeStore();
    await request(store, { status: 200, durationMs: 20 });
    await request(store, { status: 200, durationMs: 50 });
    await request(store, { status: 500, durationMs: 300, url: '/boom' });
    await request(store, { status: 404, durationMs: 15, url: '/missing' });
    await store.record({
      type: EntryType.Query,
      familyHash: 'q:users',
      content: { sql: 'select * from users where id = ?' },
      durationMs: 600,
    });
    await store.record({
      type: EntryType.Exception,
      familyHash: 'Error:boom',
      content: { name: 'TypeError', message: 'boom' },
    });
    await store.record({
      type: EntryType.Exception,
      familyHash: 'Error:boom',
      content: { name: 'TypeError', message: 'boom' },
    });

    const report = await new PulseService(store).getHealth({ windowMs: HOUR });

    // Per-type counts.
    expect(report.counts).toMatchObject({ request: 4, query: 1, exception: 2 });

    // Slowest across all types — the 600ms query leads, then the 300ms request.
    expect(report.slowest[0]).toMatchObject({
      type: 'query',
      durationMs: 600,
      label: 'select * from users where id = ?',
    });
    expect(report.slowest[1]).toMatchObject({
      type: 'request',
      durationMs: 300,
      label: 'GET /boom',
    });

    // Error rate = (4xx + 5xx) / total requests = 2 / 4.
    expect(report.requests.total).toBe(4);
    expect(report.requests.errorRate).toBe(0.5);
    expect(report.requests.status).toMatchObject({ '2xx': 2, '4xx': 1, '5xx': 1 });
    expect(report.requests.latency?.max).toBe(300);

    // Throughput — 7 entries over a 60-minute window ⇒ 7/60 per minute.
    expect(report.throughput.total).toBe(7);
    expect(report.throughput.perMinute).toBeCloseTo(7 / 60, 6);
    expect(report.throughput.overTime.buckets.length).toBeGreaterThan(0);

    // Top exceptions — one family, seen twice.
    expect(report.topExceptions).toHaveLength(1);
    expect(report.topExceptions[0]).toMatchObject({
      key: 'Error:boom',
      class: 'TypeError',
      message: 'boom',
      count: 2,
    });

    expect(report.scanned).toBe(7);
    expect(report.truncated).toBe(false);
  });

  it('ranks slow-route hotspots by p99 and honours the slowRouteMs gate', async () => {
    const store = new InMemoryTelescopeStore();
    for (const durationMs of [10, 20, 30, 1200]) {
      await request(store, { status: 200, durationMs, familyHash: 'GET /api/slow/:id' });
    }
    for (const durationMs of [5, 6, 7, 8]) {
      await request(store, { status: 200, durationMs, familyHash: 'GET /api/fast' });
    }

    // Default slowRouteMs (1000): only the slow route's p99 (1200) clears the gate.
    const gated = await new PulseService(store).getHealth({ windowMs: HOUR });
    expect(gated.slowRoutes.map((r) => r.route)).toEqual(['GET /api/slow/:id']);
    expect(gated.slowRoutes[0]).toMatchObject({ route: 'GET /api/slow/:id', count: 4, p99: 1200 });

    // slowRouteMs: 0 disables the gate ⇒ both families rank by p99.
    const ungated = await new PulseService(store, { slowRouteMs: 0 }).getHealth({ windowMs: HOUR });
    expect(ungated.slowRoutes.map((r) => r.route)).toEqual(['GET /api/slow/:id', 'GET /api/fast']);
  });

  it('detects N+1 hotspots grouped by trace', async () => {
    const store = new InMemoryTelescopeStore();
    // A driving query + 6 repeats of one child template in a single trace.
    await store.record({
      type: EntryType.Query,
      familyHash: 'q:authors',
      content: { sql: 'select * from authors' },
      durationMs: 5,
      traceId: 'req-1',
    });
    for (let i = 0; i < 6; i += 1) {
      await store.record({
        type: EntryType.Query,
        familyHash: 'q:books',
        content: { sql: 'select * from books where author_id = ?' },
        durationMs: 4,
        traceId: 'req-1',
      });
    }

    const report = await new PulseService(store, { nPlusOneThreshold: 5 }).getHealth({
      windowMs: HOUR,
    });

    expect(report.nPlusOne).toHaveLength(1);
    expect(report.nPlusOne[0]).toMatchObject({
      familyHash: 'q:books',
      sql: 'select * from books where author_id = ?',
      perRequest: 6,
      traces: 1,
      total: 6,
      totalDurationMs: 24,
      sampleTraceId: 'req-1',
    });
  });

  it('computes cache hit ratio and load-by-user', async () => {
    const store = new InMemoryTelescopeStore();
    for (const operation of ['hit', 'hit', 'hit', 'miss', 'write']) {
      await store.record({
        type: EntryType.Cache,
        content: { operation, key: 'user:1' },
      });
    }
    await request(store, { status: 200, durationMs: 40, user: '42' });
    await request(store, { status: 200, durationMs: 60, user: '42' });
    await request(store, { status: 200, durationMs: 10, user: '7' });

    const report = await new PulseService(store).getHealth({ windowMs: HOUR });

    expect(report.cache).toMatchObject({ hits: 3, misses: 1, sets: 1, hitRatio: 0.75 });
    expect(report.loadByUser[0]).toMatchObject({ user: '42', count: 2, totalDurationMs: 100 });
    expect(report.loadByUser[1]).toMatchObject({ user: '7', count: 1, totalDurationMs: 10 });
  });

  it('excludes entries older than the window (fake clock)', async () => {
    const store = new InMemoryTelescopeStore();
    const base = new Date('2026-01-01T12:00:00.000Z');
    vi.useFakeTimers();

    vi.setSystemTime(new Date(base.getTime() - 10 * 60_000)); // 10 min ago
    await request(store, { status: 200, durationMs: 10, url: '/old' });

    vi.setSystemTime(base); // now
    await request(store, { status: 200, durationMs: 20, url: '/new' });

    const report = await new PulseService(store).getHealth({ windowMs: 60_000 });
    expect(report.scanned).toBe(1);
    expect(report.counts).toMatchObject({ request: 1 });
    expect(report.slowest[0]?.label).toBe('GET /new');
  });

  it('rejects a non-positive window', async () => {
    const service = new PulseService(new InMemoryTelescopeStore());
    await expect(service.getHealth({ windowMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(service.getHealth({ windowMs: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it('reports truncation when the scan hits its cap', async () => {
    const store = new InMemoryTelescopeStore({ maxEntries: 10 });
    for (let i = 0; i < 6; i += 1) {
      await request(store, { status: 200, durationMs: i + 1 });
    }
    const report = await new PulseService(store, { scanCap: 3 }).getHealth({ windowMs: HOUR });
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(true);
  });

  it('honours the enabled-cards toggle', async () => {
    const store = new InMemoryTelescopeStore();
    await request(store, { status: 500, durationMs: 1500, familyHash: 'GET /slow' });

    const report = await new PulseService(store, {
      cards: ['throughput', 'requests'],
      slowRouteMs: 0,
    }).getHealth({ windowMs: HOUR });

    // Enabled cards are populated…
    expect(report.throughput.total).toBe(1);
    expect(report.requests.total).toBe(1);
    // …while disabled cards are empty/omitted.
    expect(report.slowest).toEqual([]);
    expect(report.slowRoutes).toEqual([]);
    expect(report.topExceptions).toEqual([]);
    expect(report.cache).toBeUndefined();
    // counts + window meta are always present.
    expect(report.counts).toMatchObject({ request: 1 });
  });

  it('is exposed through TelescopeService.getHealth', async () => {
    const store = new InMemoryTelescopeStore();
    await request(store, { status: 200, durationMs: 25 });
    const service = new TelescopeService(store, { windowMs: HOUR });

    const report = await service.getHealth();
    expect(report.counts).toMatchObject({ request: 1 });
    expect(report.requests.total).toBe(1);
  });
});

describe('summarizePulse (pure)', () => {
  it('produces a stable summary over supplied entries and bounds', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const start = new Date(now.getTime() - HOUR);
    const options: PulseOptions = {
      topN: 5,
      buckets: 10,
      slowMs: 100,
      slowRouteMs: 0,
      hotspotMinCount: 1,
      nPlusOneThreshold: 5,
      cards: new Set(['slowest', 'requests', 'throughput']),
    };
    const summary = summarizePulse(
      [
        {
          id: 'a',
          type: EntryType.Request,
          familyHash: 'GET /x',
          content: { method: 'GET', url: '/x', status: 200 },
          tags: [],
          sequence: 0,
          durationMs: 42,
          origin: 'http',
          traceId: 't1',
          createdAt: now,
        },
      ],
      start,
      now,
      options,
    );
    expect(summary.windowMs).toBe(HOUR);
    expect(summary.slowest[0]).toMatchObject({ id: 'a', durationMs: 42, label: 'GET /x' });
    expect(summary.requests.total).toBe(1);
    expect(summary.throughput.total).toBe(1);
  });
});

/**
 * Browser-reported errors count as errors.
 *
 * The alert poller has always read BOTH `exception` and `client_exception`
 * (EXCEPTION_ENTRY_TYPES), but the pulse rollup classified only the server type —
 * so a front-end-only incident paged on Slack/Discord while the overview it linked
 * to rendered "Recent failures: No exceptions 🎉". Same data, two answers.
 */
describe('PulseService — client_exception counts as an exception', () => {
  it('includes browser-reported exceptions in topExceptions', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.ClientException,
      familyHash: 'TypeError:find',
      content: { name: 'TypeError', message: 'm?.find is not a function' },
      tags: ['failed', 'client'],
    });

    const report = await new PulseService(store).getHealth({ windowMs: HOUR });

    expect(report.topExceptions).toHaveLength(1);
    expect(report.topExceptions[0]).toMatchObject({
      class: 'TypeError',
      message: 'm?.find is not a function',
      count: 1,
    });
  });

  it('groups server and browser exceptions side by side', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.Exception,
      familyHash: 'Error:server',
      content: { name: 'Error', message: 'server boom' },
    });
    await store.record({
      type: EntryType.ClientException,
      familyHash: 'Error:browser',
      content: { name: 'Error', message: 'browser boom' },
    });

    const report = await new PulseService(store).getHealth({ windowMs: HOUR });

    expect(report.topExceptions.map((group) => group.message).sort()).toEqual([
      'browser boom',
      'server boom',
    ]);
  });
});
