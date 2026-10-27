import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '../src/stores/factory.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import type { TieredTelescopeStore } from '../src/stores/tiered.js';
import { fakeApp, tempDir } from './parquet_helpers.js';

const START = Date.UTC(2026, 9, 20, 9, 0);

describe('tiered store move to cold', () => {
  let tmp: ReturnType<typeof tempDir>;
  let hot: InMemoryTelescopeStore;
  let store: TieredTelescopeStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    tmp = tempDir('telescope-tiered-paging-');
    hot = new InMemoryTelescopeStore({ maxEntries: 10_000 });
    store = (await storage.tiered({
      hot,
      cold: storage.parquet({ location: { dir: tmp.dir }, engine: 'hyparquet' }),
      hotFor: '2m',
      moveBatchSize: 4,
    })(fakeApp)) as TieredTelescopeStore;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
    tmp.cleanup();
  });

  it('pages by time, never by offset, and moves entries that share a millisecond together', async () => {
    // 40 entries, five per millisecond: page boundaries keep landing inside a millisecond.
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(START + Math.floor(i / 5));
      ids.push((await store.record({ type: 'query', content: { i } })).id);
    }
    vi.setSystemTime(START + 10 * 60_000);
    const list = vi.spyOn(hot, 'list');

    await store.prune(new Date(START - 60 * 60_000));

    expect(list.mock.calls.every(([query]) => (query?.page ?? 1) === 1)).toBe(true);
    expect(store.lastPrune()?.moved).toBe(40);
    expect(await hot.count()).toBe(0);
    const cold = await store.list({ size: 100 });
    expect(new Set(cold.map((entry) => entry.id))).toEqual(new Set(ids));
    expect(cold).toHaveLength(40);
  });
});
