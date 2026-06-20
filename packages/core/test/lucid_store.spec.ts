import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LucidTelescopeStore } from '../src/stores/lucid.js';
import { type TestHarness, makeHarness } from './lucid_helpers.js';

let harness: TestHarness;
let store: LucidTelescopeStore;

beforeEach(async () => {
  harness = await makeHarness();
  store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('LucidTelescopeStore', () => {
  it('records an entry and reads it back by id', async () => {
    const entry = await store.record({
      type: 'diagnostic',
      content: { hello: 'world' },
      familyHash: 'billing:paid',
      tags: ['lib:billing'],
      traceId: 't1',
    });

    expect(entry.id).toBeTypeOf('string');
    expect(entry.sequence).toBe(0);
    expect(entry.createdAt).toBeInstanceOf(Date);

    const fetched = await store.get(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.type).toBe('diagnostic');
    expect(fetched?.familyHash).toBe('billing:paid');
    expect(fetched?.traceId).toBe('t1');
    expect(fetched?.tags).toEqual(['lib:billing']);
    expect(fetched?.origin).toBe('manual');
    expect(await store.get('absent')).toBeNull();
  });

  it('round-trips JSON content (objects, arrays, nested)', async () => {
    const content = { a: 1, b: ['x', 'y'], c: { d: true, e: null } };
    const entry = await store.record({ type: 'x', content });
    const fetched = await store.get(entry.id);
    expect(fetched?.content).toEqual(content);
  });

  it('increments sequence per record', async () => {
    const a = await store.record({ type: 'x', content: 1 });
    const b = await store.record({ type: 'x', content: 2 });
    expect(b.sequence).toBe(a.sequence + 1);
  });

  it('lists newest-first', async () => {
    await store.record({ type: 'x', content: 'first' });
    await store.record({ type: 'x', content: 'second' });
    const list = await store.list();
    expect(list.map((e) => e.content)).toEqual(['second', 'first']);
  });

  it('filters by type, tag, familyHash and traceId', async () => {
    await store.record({ type: 'request', content: {}, tags: ['method:GET'], traceId: 't1' });
    await store.record({
      type: 'diagnostic',
      content: {},
      tags: ['lib:billing'],
      familyHash: 'billing:paid',
      traceId: 't2',
    });

    expect(await store.list({ type: 'request' })).toHaveLength(1);
    expect(await store.list({ tag: 'lib:billing' })).toHaveLength(1);
    expect(await store.list({ familyHash: 'billing:paid' })).toHaveLength(1);
    expect((await store.list({ traceId: 't2' }))[0]?.type).toBe('diagnostic');
    expect(await store.list({ traceId: 'nope' })).toHaveLength(0);
  });

  it('tag filter matches the exact token (no prefix bleed)', async () => {
    await store.record({ type: 'x', content: {}, tags: ['lib:billing'] });
    await store.record({ type: 'x', content: {}, tags: ['lib:bill'] });
    expect(await store.list({ tag: 'lib:bill' })).toHaveLength(1);
    expect(await store.list({ tag: 'lib:billing' })).toHaveLength(1);
  });

  it('search matches content and tags case-insensitively', async () => {
    await store.record({ type: 'request', content: { url: '/Users/42' }, tags: [] });
    await store.record({ type: 'request', content: { url: '/health' }, tags: ['status:500'] });

    expect(await store.list({ search: 'users' })).toHaveLength(1);
    expect(await store.list({ search: '500' })).toHaveLength(1);
    expect(await store.list({ search: 'absent' })).toHaveLength(0);
  });

  it('search escapes LIKE wildcards so they match literally', async () => {
    await store.record({ type: 'x', content: { note: '100% sure' } });
    await store.record({ type: 'x', content: { note: 'a_b' } });
    await store.record({ type: 'x', content: { note: 'plain' } });

    // `%` and `_` are LIKE wildcards; escaped they must match the literal char.
    expect(await store.list({ search: '100%' })).toHaveLength(1);
    expect(await store.list({ search: 'a_b' })).toHaveLength(1);
    // A bare wildcard search must NOT match everything.
    expect(await store.list({ search: 'zzz%' })).toHaveLength(0);
  });

  it('honours limit', async () => {
    for (let i = 0; i < 5; i++) await store.record({ type: 'x', content: i });
    expect(await store.list({ limit: 2 })).toHaveLength(2);
  });

  it('filters by before/after instants', async () => {
    const e = await store.record({ type: 'x', content: 1 });
    const past = new Date(e.createdAt.getTime() - 1000);
    const future = new Date(e.createdAt.getTime() + 1000);
    expect(await store.list({ after: past })).toHaveLength(1);
    expect(await store.list({ before: future })).toHaveLength(1);
    expect(await store.list({ before: past })).toHaveLength(0);
  });

  it('counts stored entries', async () => {
    expect(await store.count()).toBe(0);
    await store.record({ type: 'x', content: 1 });
    await store.record({ type: 'x', content: 2 });
    expect(await store.count()).toBe(2);
  });

  it('prune deletes entries older than the cutoff (by age)', async () => {
    const old = await store.record({ type: 'x', content: 'old' });
    // Re-stamp the row to the past via a fresh store would not help; instead
    // record with an explicit recent entry and prune everything before "now".
    await store.record({ type: 'x', content: 'new' });

    // Backdate the first row directly in the DB so the cutoff splits the two.
    await harness.lucid.rawQuery('UPDATE "telescope_entries" SET "created_at" = ? WHERE "id" = ?', [
      Date.now() - 10_000,
      old.id,
    ]);

    const deleted = await store.prune(new Date(Date.now() - 5_000));
    expect(deleted).toBe(1);
    expect(await store.count()).toBe(1);
    expect(await store.get(old.id)).toBeNull();
  });

  it('prune respects keepLast (by cap)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = await store.record({ type: 'x', content: i });
      ids.push(e.id);
      await harness.lucid.rawQuery(
        'UPDATE "telescope_entries" SET "created_at" = ? WHERE "id" = ?',
        [Date.now() - 10_000 + i, e.id],
      );
    }
    // All 4 are doomed; keepLast 2 keeps the newest 2 doomed entries.
    const deleted = await store.prune(new Date(Date.now() - 1_000), 2);
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(2);
  });

  it('clear empties the store', async () => {
    const e = await store.record({ type: 'x', content: 1 });
    await store.clear();
    expect(await store.count()).toBe(0);
    expect(await store.get(e.id)).toBeNull();
  });

  it('honours an explicit traceId / origin on the input', async () => {
    const e = await store.record({ type: 'x', content: 1, traceId: 'abc', origin: 'queue' });
    expect(e.traceId).toBe('abc');
    expect(e.origin).toBe('queue');
    const fetched = await store.get(e.id);
    expect(fetched?.traceId).toBe('abc');
    expect(fetched?.origin).toBe('queue');
  });

  it('persists across a reconnect and keeps sequence climbing', async () => {
    await store.record({ type: 'x', content: 'a' });
    const second = await store.record({ type: 'x', content: 'b' });
    expect(second.sequence).toBe(1);

    // A brand-new Database + store against the same file: entries survive, and
    // sequence is reseeded from MAX(sequence) so it keeps climbing.
    const db2 = harness.reconnect();
    const store2 = new LucidTelescopeStore(db2 as never, { autoCreateTable: true });

    expect(await store2.count()).toBe(2);
    const list = await store2.list();
    expect(list.map((e) => e.content)).toEqual(['b', 'a']);

    const third = await store2.record({ type: 'x', content: 'c' });
    expect(third.sequence).toBe(2);
  });
});
