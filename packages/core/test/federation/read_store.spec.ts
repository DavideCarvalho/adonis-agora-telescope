import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { FEDERATED_READ_ONLY, FederatedReadStore } from '../../src/federation/read_store.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  SlowestQuery,
  TelescopeStore,
} from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 19, 12);

/** A store that remembers every query it was asked. */
function spyStore(rows: Entry[] = []) {
  const lists: EntryQuery[] = [];
  const buckets: BucketCountQuery[] = [];
  const slowest: SlowestQuery[] = [];
  let concurrent = 0;
  let peak = 0;
  const store: TelescopeStore = {
    honorsTagGroups: true,
    record: async () => {
      throw new Error('inner record called');
    },
    get: async (id) => rows.find((row) => row.id === id) ?? null,
    list: async (query = {}) => {
      lists.push(query);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return rows.slice(0, query.size ?? rows.length);
    },
    count: async () => {
      throw new Error('whole-table count');
    },
    prune: async () => {
      throw new Error('inner prune called');
    },
    clear: async () => {
      throw new Error('inner clear called');
    },
    countByBucket: async (query) => {
      buckets.push(query);
      return [{ index: 0, type: 'request', count: 3 }] satisfies BucketCountRow[];
    },
    listSlowest: async (query) => {
      slowest.push(query);
      return [];
    },
    countFamilies: async () => {
      throw new Error('whole-table GROUP BY family_hash');
    },
    countTags: async () => {
      throw new Error('whole-table tag scan');
    },
    listTraceIds: async () => {
      throw new Error('whole-table GROUP BY trace_id');
    },
  };
  return { store, lists, buckets, slowest, peak: () => peak };
}

function entry(id: string, tags: string[], familyHash: string | null = null): Entry {
  return {
    id,
    type: 'request',
    familyHash,
    content: null,
    tags,
    sequence: 0,
    durationMs: null,
    origin: 'http',
    traceId: null,
    createdAt: new Date(NOW),
  };
}

describe('FederatedReadStore', () => {
  it('refuses every write', async () => {
    const guarded = new FederatedReadStore(new InMemoryTelescopeStore());
    await expect(guarded.record({ type: 'log', content: {} })).rejects.toThrow(FEDERATED_READ_ONLY);
    await expect(guarded.prune(new Date())).rejects.toThrow(FEDERATED_READ_ONLY);
    await expect(guarded.clear()).rejects.toThrow(FEDERATED_READ_ONLY);
  });

  it('gives an unpaged list a page size and a window', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { now: () => NOW, maxRows: 100 });
    await guarded.list({ type: 'request' });
    expect(spy.lists[0]).toEqual({ type: 'request', size: 100, after: new Date(NOW - 24 * HOUR) });
  });

  it('caps a page and leaves a bounded paged read alone', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { now: () => NOW, maxRows: 100 });
    await guarded.list({ type: 'request', size: 50, before: new Date(NOW - HOUR) });
    await guarded.list({ size: 10_000 });
    expect(spy.lists[0]).toEqual({ type: 'request', size: 50, before: new Date(NOW - HOUR) });
    expect(spy.lists[1]).toEqual({ size: 100 });
  });

  it('bounds a search or tag filter to the search window before its `before`', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { now: () => NOW, searchWindowMs: HOUR });
    await guarded.list({ search: 'boom', size: 50 });
    await guarded.list({ tag: 'status:500', size: 50, before: new Date(NOW - 5 * HOUR) });
    await guarded.list({ anyTags: ['x'], size: 50, after: new Date(NOW - 10 * 60_000) });
    expect(spy.lists[0]?.after).toEqual(new Date(NOW - HOUR));
    expect(spy.lists[1]?.after).toEqual(new Date(NOW - 6 * HOUR));
    // A later start than the window is kept.
    expect(spy.lists[2]?.after).toEqual(new Date(NOW - 10 * 60_000));
  });

  it('reads a trace by its index, without a window', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { now: () => NOW, maxRows: 500 });
    await guarded.list({ traceId: 't1' });
    expect(spy.lists[0]).toEqual({ traceId: 't1', size: 500 });
  });

  it('cuts an aggregate window to maxWindow and shifts the bucket indices back', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { maxWindowMs: 2 * HOUR });
    const before = new Date(NOW);
    const rows = await guarded.countByBucket?.({
      after: new Date(NOW - 6 * HOUR),
      before,
      bucketMs: HOUR,
    });
    expect(spy.buckets[0]?.after).toEqual(new Date(NOW - 2 * HOUR));
    // Index 0 of the cut window is bucket 4 of the asked one.
    expect(rows).toEqual([{ index: 4, type: 'request', count: 3 }]);
    await guarded.listSlowest?.({ after: new Date(0), before, limit: 5 });
    expect(spy.slowest[0]?.after).toEqual(new Date(NOW - 2 * HOUR));
  });

  it('never runs a whole-table aggregate: counts and tops come from the newest entries', async () => {
    const rows = [
      entry('1', ['status:500', 'lib:a'], 'f1'),
      entry('2', ['status:500'], 'f1'),
      entry('3', ['status:200'], 'f2'),
    ];
    const spy = spyStore(rows);
    const guarded = new FederatedReadStore(spy.store, { now: () => NOW });
    expect('listTraceIds' in guarded).toBe(false);
    expect(await guarded.count()).toBe(3);
    expect(await guarded.countFamilies({ limit: 1 })).toEqual([{ key: 'f1', count: 2 }]);
    expect(await guarded.countTags({ limit: 5, prefix: 'status:' })).toEqual([
      { key: 'status:500', count: 2 },
      { key: 'status:200', count: 1 },
    ]);
    for (const query of spy.lists) expect(query.size).toBeGreaterThan(0);
  });

  it('runs at most maxConcurrentReads queries at once', async () => {
    const spy = spyStore();
    const guarded = new FederatedReadStore(spy.store, { maxConcurrentReads: 2 });
    await Promise.all(Array.from({ length: 8 }, () => guarded.list({ size: 1 })));
    expect(spy.lists).toHaveLength(8);
    expect(spy.peak()).toBe(2);
  });
});
