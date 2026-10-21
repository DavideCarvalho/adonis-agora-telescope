import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../src/entry.js';
import { storage } from '../src/stores/factory.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import type { TieredTelescopeStore } from '../src/stores/tiered.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';
import {
  ENGINES,
  fakeApp,
  ids,
  referenceBuckets,
  referenceList,
  sortBuckets,
  tempDir,
} from './parquet_helpers.js';

const START = Date.UTC(2026, 9, 20, 9, 0);
const MINUTE = 60_000;

/**
 * Record `count` entries one second apart starting at `START`, by moving the clock —
 * the hot stores stamp `createdAt` themselves.
 */
async function recordSpread(store: TieredTelescopeStore, count: number): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(START + i * 1000);
    out.push(
      await store.record({
        type: i % 2 === 0 ? 'request' : 'query',
        content: { i, url: `/r/${i % 5}` },
        tags: [`n:${i % 3}`],
        traceId: `t-${i % 12}`,
        durationMs: i,
      }),
    );
  }
  return out;
}

describe.each(ENGINES)('tiered store (memory hot, %s cold)', (engine) => {
  let tmp: ReturnType<typeof tempDir>;
  let store: TieredTelescopeStore;
  let hot: InMemoryTelescopeStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    tmp = tempDir('telescope-tiered-');
    hot = new InMemoryTelescopeStore({ maxEntries: 100_000 });
    store = (await storage.tiered({
      hot,
      cold: storage.parquet({ location: { dir: tmp.dir }, engine, rowGroupSize: 50 }),
      hotFor: '2m',
      moveBatchSize: 37,
    })(fakeApp)) as TieredTelescopeStore;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
    tmp.cleanup();
  });

  it('moves entries older than hotFor to cold on prune, deleting them from hot', async () => {
    const all = await recordSpread(store, 600); // 10 minutes of entries
    vi.setSystemTime(START + 600 * 1000);
    const retention = new Date(START - 60 * MINUTE);
    await store.prune(retention);

    const report = store.lastPrune()!;
    const hotLeft = await hot.count();
    // Only the last ~2 minutes stay hot.
    expect(hotLeft).toBeGreaterThan(100);
    expect(hotLeft).toBeLessThanOrEqual(121);
    expect(report.moved).toBe(600 - hotLeft);
    expect(report.hotDeleted).toBe(report.moved);
    expect(await store.cold.count()).toBe(report.moved);
    expect(await store.count()).toBe(all.length);
  });

  it('keeps the newest keepLast entries when hot entries are already past retention', async () => {
    await recordSpread(store, 600);
    vi.setSystemTime(START + 3 * 60 * MINUTE);
    await store.prune(new Date(START + 2 * 60 * MINUTE), 100);

    // Cold expiry keeps whole files, so at least 100 survive.
    expect(await store.count()).toBeGreaterThanOrEqual(100);
    expect(await hot.count()).toBe(0);
  });

  it('pages across the tier boundary newest-first, gap-free, without duplicates', async () => {
    const all = await recordSpread(store, 400);
    vi.setSystemTime(START + 400 * 1000);
    await store.prune(new Date(START - 60 * MINUTE));
    expect(await store.cold.count()).toBeGreaterThan(0);

    const seen: string[] = [];
    for (let page = 1; ; page++) {
      const rows = await store.list({ page, size: 45 });
      if (rows.length === 0) break;
      seen.push(...ids(rows));
    }
    expect(seen).toEqual(ids(referenceList(all, {})));
    expect(new Set(seen).size).toBe(all.length);

    for (const query of [
      { type: 'query', size: 30, page: 3 },
      { tag: 'n:1', size: 20, page: 2 },
      { traceId: 't-5' },
      { search: '/r/3', size: 12 },
      { before: new Date(START + 200 * 1000), size: 25 },
    ]) {
      expect(ids(await store.list(query))).toEqual(ids(referenceList(all, query)));
    }
  });

  it('serves get, traces and bucket counts from both tiers', async () => {
    const all = await recordSpread(store, 300);
    vi.setSystemTime(START + 300 * 1000);
    await store.prune(new Date(START - 60 * MINUTE));

    const oldest = all[0]!;
    const newest = all[all.length - 1]!;
    expect((await store.get(oldest.id))?.id).toBe(oldest.id);
    expect((await store.get(newest.id))?.id).toBe(newest.id);

    const traces = await store.listTraceIds({ size: 12 });
    expect(traces).toHaveLength(12);
    const lastSeen = new Map<string, number>();
    for (const e of all) lastSeen.set(e.traceId!, e.createdAt.getTime());
    for (const row of traces) expect(row.lastAt.getTime()).toBe(lastSeen.get(row.traceId));

    const query = {
      after: new Date(START - 1),
      before: new Date(START + 300 * 1000),
      bucketMs: MINUTE,
    };
    expect(sortBuckets(await store.countByBucket(query))).toEqual(referenceBuckets(all, query));
  });

  it('expires the cold tier at the prune cutoff', async () => {
    await recordSpread(store, 60);
    vi.setSystemTime(START + 3 * 60 * MINUTE);
    // Retention 1h: the 09:00 hour has fully expired by 12:00, nothing reaches cold.
    await store.prune(new Date(START + 2 * 60 * MINUTE));
    expect(await store.count()).toBe(0);

    await recordSpread(store, 60);
    vi.setSystemTime(START + 10 * MINUTE);
    await store.prune(new Date(START - 60 * MINUTE));
    expect(await store.cold.count()).toBe(60);
    vi.setSystemTime(START + 2 * 60 * MINUTE + 1);
    await store.prune(new Date(START + 60 * MINUTE + 1));
    expect(store.lastPrune()!.coldExpired).toBe(60);
    expect(await store.count()).toBe(0);
  });

  it('leaves hot untouched and removes partial files when a cold write fails', async () => {
    await recordSpread(store, 200);
    vi.setSystemTime(START + 200 * 1000);
    const location = store.cold.location;
    const real = location.write.bind(location);
    let calls = 0;
    const write = vi.spyOn(location, 'write').mockImplementation(async (key, bytes) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return real(key, bytes);
    });
    await expect(store.prune(new Date(START - 60 * MINUTE))).rejects.toThrow('disk full');
    write.mockRestore();
    expect(await hot.count()).toBe(200);
    expect(await store.cold.count()).toBe(0);
  });

  it('serves hot entries when the cold tier cannot be read', async () => {
    const all = await recordSpread(store, 300);
    vi.setSystemTime(START + 300 * 1000);
    await store.prune(new Date(START - 60 * MINUTE));
    const warn = vi.fn();
    (store as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    vi.spyOn(store.cold, 'top').mockRejectedValue(new Error('S3 down'));
    vi.spyOn(store.cold, 'newestCreatedAt').mockRejectedValue(new Error('S3 down'));

    const rows = await store.list({ size: 500 });
    expect(rows.length).toBe(await hot.count());
    expect(ids(rows)).toEqual(ids(referenceList(all, { size: rows.length })));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('S3 down'));
  });

  it('does not double-move when an earlier cycle crashed after writing', async () => {
    const all = await recordSpread(store, 120);
    vi.setSystemTime(START + 5 * MINUTE);
    // Simulate a crash between "files written" and "hot deleted".
    const prune = vi.spyOn(hot, 'prune').mockRejectedValueOnce(new Error('crash'));
    await expect(store.prune(new Date(START - 60 * MINUTE))).rejects.toThrow('crash');
    prune.mockRestore();
    await store.prune(new Date(START - 60 * MINUTE));
    // Rows exist twice in cold now, but reads never return an id twice.
    const rows = await store.list();
    expect(ids(rows)).toEqual(ids(referenceList(all, {})));
  });
});

describe('tiered store with a Lucid hot tier (sqlite)', () => {
  let harness: TestHarness;
  let tmp: ReturnType<typeof tempDir>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    harness = await makeHarness();
    tmp = tempDir('telescope-tiered-lucid-');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await harness.cleanup();
    tmp.cleanup();
  });

  it.each(ENGINES)('moves, merges and expires end to end (%s)', async (engine) => {
    const app = {
      container: { make: async () => harness.db },
    } as unknown as ApplicationService;
    const store = (await storage.tiered({
      hot: storage.lucid({ autoCreateTable: true }),
      cold: storage.parquet({ location: { dir: tmp.dir }, engine }),
      hotFor: '1m',
    })({ app })) as TieredTelescopeStore;

    const all = await recordSpread(store, 240);
    vi.setSystemTime(START + 240 * 1000);
    await store.prune(new Date(START - 60 * MINUTE));
    expect(store.lastPrune()!.moved).toBeGreaterThan(150);

    const seen: string[] = [];
    for (let page = 1; page < 20; page++) {
      const rows = await store.list({ page, size: 50 });
      seen.push(...ids(rows));
      if (rows.length < 50) break;
    }
    expect(seen).toEqual(ids(referenceList(all, {})));
    expect(await store.count()).toBe(240);
    await store.close();
  });
});

describe('DuckDB lockdown', () => {
  it('cannot load httpfs or read outside the data directory', async () => {
    const tmp = tempDir('telescope-duckdb-');
    try {
      const cold = await storage.parquet({ location: { dir: tmp.dir }, engine: 'duckdb' })(fakeApp);
      const instance = (cold.engine as unknown as { instance: { connect(): Promise<any> } })
        .instance;
      const connection = await instance.connect();
      for (const sql of [
        'INSTALL httpfs',
        'LOAD httpfs',
        "SELECT * FROM read_parquet('https://example.com/a.parquet')",
        "SELECT * FROM read_csv('/etc/passwd')",
        'SET enable_external_access = true',
      ]) {
        await expect(connection.run(sql)).rejects.toThrow();
      }
      connection.closeSync();
      await cold.close();
    } finally {
      tmp.cleanup();
    }
  });
});
