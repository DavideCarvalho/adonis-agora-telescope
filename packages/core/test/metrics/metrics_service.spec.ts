import { describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
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
