import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FUTURE_SKEW_MS, resolveCreatedAt, resolveEntryId } from '../src/entry.js';
import { MetricsService } from '../src/metrics/metrics_service.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import type { TelescopeStore } from '../src/store.js';
import { storage } from '../src/stores/factory.js';
import { LucidTelescopeStore } from '../src/stores/lucid.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import type { TieredTelescopeStore } from '../src/stores/tiered.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';
import { ENGINES, fakeApp, tempDir } from './parquet_helpers.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0);
const MINUTE = 60_000;

describe('resolveCreatedAt / resolveEntryId', () => {
  it('keeps a sane time, takes an invalid or far-future one as now', () => {
    expect(resolveCreatedAt(undefined, NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt(new Date(NOW - 3_600_000), NOW).getTime()).toBe(NOW - 3_600_000);
    expect(resolveCreatedAt(new Date(NOW - 60_000).toISOString(), NOW).getTime()).toBe(
      NOW - 60_000,
    );
    // A little clock skew between machines is fine; more is clamped.
    expect(resolveCreatedAt(new Date(NOW + MAX_FUTURE_SKEW_MS), NOW).getTime()).toBe(
      NOW + MAX_FUTURE_SKEW_MS,
    );
    expect(resolveCreatedAt(new Date(NOW + MAX_FUTURE_SKEW_MS + 1), NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt('2999-01-01T00:00:00Z', NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt('not a date', NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt(new Date(Number.NaN), NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt(new Date(-1), NOW).getTime()).toBe(NOW);
  });

  it('keeps a printable id up to 255 characters, else makes a UUID', () => {
    expect(resolveEntryId('shop:0f8e-1')).toBe('shop:0f8e-1');
    for (const bad of ['', 'a b', 'x'.repeat(256), 'tab\there', 42, null]) {
      expect(resolveEntryId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

/** The contract every store honours, run against each one. */
function contract(make: () => Promise<{ store: TelescopeStore; flush?: () => Promise<void> }>) {
  let store: TelescopeStore;
  let flush: () => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const made = await make();
    store = made.store;
    flush = made.flush ?? (async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('without createdAt/id: stamped now with a fresh id, as before', async () => {
    const entry = await store.record({ type: 'log', content: {} });
    expect(entry.createdAt.getTime()).toBe(NOW);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the given createdAt and id, and reads come back in createdAt order', async () => {
    await store.record({ type: 'log', content: { n: 'now' } });
    const late = await store.record({
      type: 'log',
      content: { n: 'ten minutes ago' },
      createdAt: new Date(NOW - 10 * MINUTE),
      id: 'shop:late-1',
    });
    await store.record({
      type: 'log',
      content: { n: 'five minutes ago' },
      createdAt: new Date(NOW - 5 * MINUTE).toISOString(),
    });
    await flush();
    expect(late.id).toBe('shop:late-1');
    expect(late.createdAt.getTime()).toBe(NOW - 10 * MINUTE);
    expect((await store.get('shop:late-1'))?.createdAt.getTime()).toBe(NOW - 10 * MINUTE);
    const order = (await store.list()).map((e) => (e.content as { n: string }).n);
    expect(order).toEqual(['now', 'five minutes ago', 'ten minutes ago']);
    // Time windows use the given time.
    const recent = await store.list({ after: new Date(NOW - 7 * MINUTE) });
    expect(recent.map((e) => (e.content as { n: string }).n)).toEqual(['now', 'five minutes ago']);
  });

  it('a far-future createdAt cannot jump the queue: it is taken as now', async () => {
    await store.record({
      type: 'log',
      content: { n: 'earlier' },
      createdAt: new Date(NOW - MINUTE),
    });
    const poisoned = await store.record({
      type: 'log',
      content: { n: 'poisoned' },
      createdAt: new Date(NOW + 365 * 24 * 60 * MINUTE),
    });
    await flush();
    expect(poisoned.createdAt.getTime()).toBe(NOW);
    expect((await store.get(poisoned.id))?.createdAt.getTime()).toBe(NOW);
  });

  it('recording an id it already holds stores nothing new', async () => {
    await store.record({ type: 'log', content: { n: 1 }, id: 'dup-1' });
    await flush();
    await expect(
      store.record({ type: 'log', content: { n: 2 }, id: 'dup-1' }),
    ).resolves.toBeTruthy();
    await flush();
    expect(await store.count()).toBe(1);
    expect((await store.get('dup-1'))?.content).toEqual({ n: 1 });
  });

  it('prune and metrics read the given createdAt', async () => {
    await store.record({ type: 'request', content: {}, createdAt: new Date(NOW - 90 * MINUTE) });
    await store.record({ type: 'request', content: {}, createdAt: new Date(NOW - 2 * MINUTE) });
    await flush();
    // The last hour's throughput counts the recent entry only.
    const series = await new MetricsService(store).getTimeseries({
      windowMs: 60 * MINUTE,
      buckets: 6,
    });
    expect(series.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(1);
    expect(await store.prune(new Date(NOW - 60 * MINUTE))).toBe(1);
    expect(await store.count()).toBe(1);
  });
}

describe('memory store', () => {
  contract(async () => ({ store: new InMemoryTelescopeStore({ maxEntries: 100 }) }));

  it('evicts by createdAt: a backdated entry is the first to go', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const store = new InMemoryTelescopeStore({ maxEntries: 2 });
    await store.record({ type: 'log', content: { n: 'a' } });
    await store.record({ type: 'log', content: { n: 'b' } });
    await store.record({ type: 'log', content: { n: 'old' }, createdAt: new Date(NOW - MINUTE) });
    expect((await store.list()).map((e) => (e.content as { n: string }).n)).toEqual(['b', 'a']);
    vi.useRealTimers();
  });

  it('passes through the decorators (redaction)', async () => {
    const store = new RedactingTelescopeStore(new InMemoryTelescopeStore(), { keys: [] } as never);
    const entry = await store.record({
      type: 'log',
      content: {},
      id: 'kept',
      createdAt: new Date(Date.now() - MINUTE),
    });
    expect(entry.id).toBe('kept');
    expect(Date.now() - entry.createdAt.getTime()).toBeGreaterThanOrEqual(MINUTE - 5);
  });
});

describe('lucid store (sqlite)', () => {
  let harness: TestHarness;
  afterEach(async () => {
    await harness.cleanup();
  });
  contract(async () => {
    harness = await makeHarness();
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    return { store, flush: () => store.flush() };
  });
});

describe.each(ENGINES)('tiered store (memory hot, %s cold)', (engine) => {
  let tmp: ReturnType<typeof tempDir>;
  let tiered: TieredTelescopeStore;
  afterEach(async () => {
    await tiered.close();
    tmp.cleanup();
  });
  contract(async () => {
    tmp = tempDir('telescope-created-at-');
    tiered = (await storage.tiered({
      hot: new InMemoryTelescopeStore({ maxEntries: 1000 }),
      cold: storage.parquet({ location: { dir: tmp.dir }, engine }),
      hotFor: '2m',
    })(fakeApp)) as TieredTelescopeStore;
    return { store: tiered };
  });

  it('a backdated entry moves to cold by its createdAt and keeps it there', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const entry = await tiered.record({
      type: 'log',
      content: { n: 'old' },
      createdAt: new Date(NOW - 10 * MINUTE),
      id: 'moved-1',
    });
    await tiered.record({ type: 'log', content: { n: 'fresh' } });
    await tiered.prune(new Date(NOW - 60 * MINUTE));
    const cold = await tiered.get('moved-1');
    expect(cold?.createdAt.getTime()).toBe(entry.createdAt.getTime());
    expect((await tiered.list()).map((e) => (e.content as { n: string }).n)).toEqual([
      'fresh',
      'old',
    ]);
    vi.useRealTimers();
  });
});
