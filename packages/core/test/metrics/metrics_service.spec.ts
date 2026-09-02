import { describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import type { TelescopeStore } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

async function seedNPlusOne(store: InMemoryTelescopeStore) {
  // Recorded oldest-first; the store returns newest-first, and MetricsService
  // reverses internally to recover record order.
  await store.record({
    type: EntryType.Query,
    familyHash: 'authors',
    content: { sql: 'select * from author' },
    durationMs: 5,
    traceId: 'req-1',
  });
  for (let i = 0; i < 3; i += 1) {
    await store.record({
      type: EntryType.Query,
      familyHash: 'book',
      content: { sql: 'select * from book where author_id = ?' },
      durationMs: 4,
      traceId: 'req-1',
    });
  }
}

describe('MetricsService', () => {
  it('detects N+1 patterns over a trace with correct parent attribution', async () => {
    const store = new InMemoryTelescopeStore();
    await seedNPlusOne(store);
    const metrics = new MetricsService(store, { nPlusOneThreshold: 3 });

    const patterns = await metrics.getNPlusOne('req-1');
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.childFamilyHash).toBe('book');
    expect(patterns[0]?.count).toBe(3);
    expect(patterns[0]?.parentFamilyHash).toBe('authors');
    expect(patterns[0]?.totalDurationMs).toBe(12);
  });

  it('honours a per-call threshold override', async () => {
    const store = new InMemoryTelescopeStore();
    await seedNPlusOne(store);
    const metrics = new MetricsService(store);
    expect(await metrics.getNPlusOne('req-1', 10)).toHaveLength(0);
  });

  it('builds a per-trace waterfall and returns null for an unknown trace', async () => {
    const store = new InMemoryTelescopeStore();
    await seedNPlusOne(store);
    const metrics = new MetricsService(store);

    const wf = await metrics.getWaterfall('req-1');
    expect(wf).not.toBeNull();
    expect(wf?.spans.length).toBeGreaterThan(0);
    expect(await metrics.getWaterfall('nope')).toBeNull();
  });

  it('computes per-type stats over a window', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.Request,
      content: { status: 200 },
      durationMs: 30,
      traceId: 'r',
    });
    await store.record({
      type: EntryType.Request,
      content: { status: 500 },
      durationMs: 80,
      traceId: 'r',
    });
    const metrics = new MetricsService(store);
    const stats = await metrics.getStats({ type: EntryType.Request, windowMs: 60_000, buckets: 1 });
    expect(stats.total).toBe(2);
    expect(stats.latency?.count).toBe(2);
    expect(stats.status).toEqual({ '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 1, other: 0 });
  });

  it('rejects a non-positive windowMs', async () => {
    const metrics = new MetricsService(new InMemoryTelescopeStore());
    await expect(metrics.getStats({ type: EntryType.Request, windowMs: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('returns a throughput timeseries', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({ type: EntryType.Request, content: {}, traceId: 'r' });
    await store.record({ type: EntryType.Query, content: { sql: 'x' }, traceId: 'r' });
    const metrics = new MetricsService(store);
    const ts = await metrics.getTimeseries({ windowMs: 60_000, buckets: 1 });
    expect(ts.buckets[0]?.total).toBe(2);
  });
});

/**
 * `getStats` for an exception type spans BOTH stored types.
 *
 * `EntryQuery.type` is a single value, so scoping the window to `exception`
 * silently excluded every browser-reported `client_exception` — which is what left
 * the dashboard's exception view showing "No exceptions recorded 🎉" while those
 * entries sat in the store and the alert poller paged on them.
 */
describe('MetricsService.getStats — exception types', () => {
  async function seedBoth(store: InMemoryTelescopeStore) {
    await store.record({
      type: EntryType.Exception,
      familyHash: 'Error:server',
      content: { name: 'Error', message: 'server boom' },
    });
    await store.record({
      type: EntryType.ClientException,
      familyHash: 'TypeError:browser',
      content: { name: 'TypeError', message: 'browser boom' },
    });
  }

  it('returns server AND browser exception groups when asked for `exception`', async () => {
    const store = new InMemoryTelescopeStore();
    await seedBoth(store);

    const stats = await new MetricsService(store).getStats({
      type: EntryType.Exception,
      windowMs: 60_000,
      buckets: 1,
    });

    expect((stats.exceptions ?? []).map((group) => group.message).sort()).toEqual([
      'browser boom',
      'server boom',
    ]);
  });

  it('is symmetric — asking for `client_exception` yields the same window', async () => {
    const store = new InMemoryTelescopeStore();
    await seedBoth(store);

    const stats = await new MetricsService(store).getStats({
      type: EntryType.ClientException,
      windowMs: 60_000,
      buckets: 1,
    });

    expect((stats.exceptions ?? []).map((group) => group.message).sort()).toEqual([
      'browser boom',
      'server boom',
    ]);
  });

  it('does not widen a non-exception type', async () => {
    const store = new InMemoryTelescopeStore();
    await seedBoth(store);
    await store.record({ type: EntryType.Query, content: { sql: 'select 1' }, durationMs: 1 });

    const stats = await new MetricsService(store).getStats({
      type: EntryType.Query,
      windowMs: 60_000,
      buckets: 1,
    });

    // Only the single query entry is in scope — the two exception entries stay out.
    expect(stats.exceptions).toBeUndefined();
    expect(stats.total).toBe(1);
  });
});

/**
 * Traces used to be summarized by loading up to `scanCap` entries and grouping them
 * in JS, so asking for 50 traces could read 50.000 rows. Worse than slow: on a table
 * dominated by a chatty watcher, the budget was spent before the interesting traces
 * were reached, so the screen was slow AND incomplete.
 *
 * These tests pin both halves of the fix — that pagination is real, and that a store
 * WITHOUT the new capability still returns the same answers.
 */
describe('MetricsService.getTraces — paginação', () => {
  /** Seeds `count` traces, oldest first, so trace-N is newer than trace-(N-1). */
  async function seedTraces(store: InMemoryTelescopeStore, count: number) {
    for (let i = 0; i < count; i += 1) {
      await store.record({
        type: EntryType.Request,
        familyHash: `req-${i}`,
        content: { method: 'GET', url: `/rota/${i}` },
        durationMs: 10,
        traceId: `trace-${i}`,
      });
    }
  }

  it('devolve a página pedida, mais recente primeiro', async () => {
    const store = new InMemoryTelescopeStore();
    await seedTraces(store, 10);
    const metrics = new MetricsService(store);

    const first = await metrics.getTraces(3, 0);
    const second = await metrics.getTraces(3, 3);

    expect(first.map((t) => t.traceId)).toEqual(['trace-9', 'trace-8', 'trace-7']);
    expect(second.map((t) => t.traceId)).toEqual(['trace-6', 'trace-5', 'trace-4']);
  });

  it('páginas não se sobrepõem nem pulam traces', async () => {
    const store = new InMemoryTelescopeStore();
    await seedTraces(store, 10);
    const metrics = new MetricsService(store);

    const seen = [
      ...(await metrics.getTraces(4, 0)),
      ...(await metrics.getTraces(4, 4)),
      ...(await metrics.getTraces(4, 8)),
    ].map((t) => t.traceId);

    expect(new Set(seen).size).toBe(10);
    expect(seen).toHaveLength(10);
  });

  it('offset além do fim devolve lista vazia, não a última página', async () => {
    const store = new InMemoryTelescopeStore();
    await seedTraces(store, 3);
    const metrics = new MetricsService(store);
    expect(await metrics.getTraces(5, 99)).toEqual([]);
  });

  it('só carrega as entries da página — não a tabela inteira', async () => {
    const store = new InMemoryTelescopeStore();
    await seedTraces(store, 50);

    let listedWith: unknown = null;
    const spied = Object.create(store) as InMemoryTelescopeStore;
    spied.list = async (query = {}) => {
      listedWith = query;
      return store.list(query);
    };

    await new MetricsService(spied).getTraces(5, 0);

    // O ponto do fix: a busca de entries é restrita aos trace ids da página.
    expect((listedWith as { traceIds?: string[] }).traceIds).toHaveLength(5);
  });

  it('store SEM listTraceIds continua funcionando (capacidade, não requisito)', async () => {
    const store = new InMemoryTelescopeStore();
    await seedTraces(store, 10);

    // Um store legado: delega tudo, e simplesmente NÃO tem a capacidade nova — que
    // é a situação real de qualquer store de terceiro escrito antes dela existir.
    const legacy: TelescopeStore = {
      record: (input) => store.record(input),
      get: (id) => store.get(id),
      list: (query) => store.list(query),
      count: () => store.count(),
      prune: (olderThan, keepLast) => store.prune(olderThan, keepLast),
      clear: () => store.clear(),
    };

    const viaFallback = await new MetricsService(legacy).getTraces(3, 3);
    const viaFastPath = await new MetricsService(store).getTraces(3, 3);

    expect(viaFallback.map((t) => t.traceId)).toEqual(viaFastPath.map((t) => t.traceId));
  });
});
