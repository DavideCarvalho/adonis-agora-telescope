import { describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';

function makeStore(max?: number) {
  return new InMemoryTelescopeStore(max !== undefined ? { maxEntries: max } : {});
}

describe('InMemoryTelescopeStore', () => {
  it('records an entry with generated id, sequence and createdAt', async () => {
    const store = makeStore();
    const entry = await store.record({ type: EntryType.Diagnostic, content: { hello: 'world' } });

    expect(entry.id).toBeTypeOf('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.sequence).toBe(0);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.type).toBe(EntryType.Diagnostic);
    expect(entry.tags).toEqual([]);
    expect(entry.familyHash).toBeNull();
    expect(entry.origin).toBe('manual');
    expect(await store.count()).toBe(1);
  });

  it('increments sequence per record', async () => {
    const store = makeStore();
    const a = await store.record({ type: 'x', content: 1 });
    const b = await store.record({ type: 'x', content: 2 });
    expect(b.sequence).toBe(a.sequence + 1);
  });

  it('get returns the entry by id, null when absent', async () => {
    const store = makeStore();
    const entry = await store.record({ type: 'x', content: 1 });
    expect(await store.get(entry.id)).toBe(entry);
    expect(await store.get('nope')).toBeNull();
  });

  it('lists newest-first', async () => {
    const store = makeStore();
    await store.record({ type: 'x', content: 'first' });
    await store.record({ type: 'x', content: 'second' });
    const list = await store.list();
    expect(list.map((e) => e.content)).toEqual(['second', 'first']);
  });

  it('filters by type, tag, familyHash and traceId', async () => {
    const store = makeStore();
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

  it('search matches content and tags case-insensitively', async () => {
    const store = makeStore();
    await store.record({ type: 'request', content: { url: '/Users/42' }, tags: [] });
    await store.record({ type: 'request', content: { url: '/health' }, tags: ['status:500'] });

    expect(await store.list({ search: 'users' })).toHaveLength(1);
    expect(await store.list({ search: '500' })).toHaveLength(1);
    expect(await store.list({ search: 'absent' })).toHaveLength(0);
  });

  it('honours limit', async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) await store.record({ type: 'x', content: i });
    expect(await store.list({ limit: 2 })).toHaveLength(2);
  });

  it('filters by before/after instants', async () => {
    const store = makeStore();
    const e = await store.record({ type: 'x', content: 1 });
    const past = new Date(e.createdAt.getTime() - 1000);
    const future = new Date(e.createdAt.getTime() + 1000);
    expect(await store.list({ after: past })).toHaveLength(1);
    expect(await store.list({ before: future })).toHaveLength(1);
    expect(await store.list({ before: past })).toHaveLength(0);
  });

  it('evicts oldest beyond maxEntries (ring buffer)', async () => {
    const store = makeStore(3);
    for (let i = 0; i < 5; i++) await store.record({ type: 'x', content: i });
    expect(await store.count()).toBe(3);
    expect((await store.list()).map((e) => e.content)).toEqual([4, 3, 2]);
  });

  it('prune deletes entries older than the cutoff', async () => {
    const store = makeStore();
    const old = await store.record({ type: 'x', content: 'old' });
    // Force an older timestamp.
    (old as { createdAt: Date }).createdAt = new Date(Date.now() - 10_000);
    await store.record({ type: 'x', content: 'new' });

    const cutoff = new Date(Date.now() - 5_000);
    const deleted = await store.prune(cutoff);
    expect(deleted).toBe(1);
    expect(await store.count()).toBe(1);
    expect(await store.get(old.id)).toBeNull();
  });

  it('prune respects keepLast', async () => {
    const store = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = await store.record({ type: 'x', content: i });
      (e as { createdAt: Date }).createdAt = new Date(Date.now() - 10_000 + i);
      ids.push(e.id);
    }
    const cutoff = new Date(Date.now() - 1_000);
    // 4 are doomed; keepLast 2 keeps the newest 2 doomed entries.
    const deleted = await store.prune(cutoff, 2);
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(2);
  });

  it('clear empties the store', async () => {
    const store = makeStore();
    const e = await store.record({ type: 'x', content: 1 });
    await store.clear();
    expect(await store.count()).toBe(0);
    expect(await store.get(e.id)).toBeNull();
  });

  it('honours an explicit traceId / origin on the input', async () => {
    const store = makeStore();
    const e = await store.record({ type: 'x', content: 1, traceId: 'abc', origin: 'queue' });
    expect(e.traceId).toBe('abc');
    expect(e.origin).toBe('queue');
  });
});
