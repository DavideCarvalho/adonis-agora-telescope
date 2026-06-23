import { describe, expect, it } from 'vitest';
import type { Entry, RecordInput } from '../../src/entry.js';
import { SamplingTelescopeStore } from '../../src/sampling/sampling_store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { EntryEvents } from '../../src/stream/entry_events.js';
import { StreamingTelescopeStore } from '../../src/stream/streaming_store.js';

const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  type: 'request',
  content: { method: 'GET', url: '/' },
  ...over,
});

describe('StreamingTelescopeStore', () => {
  it('publishes each persisted entry to the bus', async () => {
    const events = new EntryEvents();
    const seen: Entry[] = [];
    events.subscribe((e) => seen.push(e));
    const store = new StreamingTelescopeStore(new InMemoryTelescopeStore(), events);

    const recorded = await store.record(input({ content: { method: 'POST', url: '/login' } }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(recorded);
    expect(seen[0].sequence).toBeGreaterThanOrEqual(0);
  });

  it('publishes the persisted entry, so list() and the stream see the same record', async () => {
    const events = new EntryEvents();
    const seen: Entry[] = [];
    events.subscribe((e) => seen.push(e));
    const inner = new InMemoryTelescopeStore();
    const store = new StreamingTelescopeStore(inner, events);

    await store.record(input());
    const listed = await store.list();

    expect(seen[0].id).toBe(listed[0].id);
  });

  it('does NOT publish a sampled-away entry (sequence -1, never persisted)', async () => {
    const events = new EntryEvents();
    const seen: Entry[] = [];
    events.subscribe((e) => seen.push(e));
    // Sampling decorator that drops everything (rate 0), wrapped by streaming as
    // the provider wires it (streaming outermost).
    const sampling = new SamplingTelescopeStore(
      new InMemoryTelescopeStore(),
      { default: { rate: 0 } },
      () => 0.99,
    );
    const store = new StreamingTelescopeStore(sampling, events);

    const result = await store.record(input());

    expect(result.sequence).toBe(-1); // dropped placeholder
    expect(seen).toHaveLength(0); // not streamed
  });

  it('is zero-overhead when nobody is subscribed (no throw, entry still stored)', async () => {
    const events = new EntryEvents();
    const inner = new InMemoryTelescopeStore();
    const store = new StreamingTelescopeStore(inner, events);

    await expect(store.record(input())).resolves.toBeDefined();
    expect(await inner.count()).toBe(1);
  });

  it('passes read operations straight through to the inner store', async () => {
    const events = new EntryEvents();
    const inner = new InMemoryTelescopeStore();
    const store = new StreamingTelescopeStore(inner, events);
    const recorded = await store.record(input({ traceId: 't1' }));

    expect(await store.get(recorded.id)).toEqual(recorded);
    expect(await store.count()).toBe(1);
    expect((await store.list({ traceId: 't1' }))[0].id).toBe(recorded.id);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
