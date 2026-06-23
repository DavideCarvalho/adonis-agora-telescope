import { describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { SamplingTelescopeStore } from '../../src/sampling/sampling_store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

describe('SamplingTelescopeStore', () => {
  it('persists entries that pass and never persists dropped ones', async () => {
    const inner = new InMemoryTelescopeStore();
    // rate 0 with a deterministic RNG → everything dropped.
    const store = new SamplingTelescopeStore(inner, { default: 0 }, () => 0.5);

    const result = await store.record({ type: EntryType.Log, content: { level: 'log' } });
    expect(result.sequence).toBe(-1); // synthetic, not persisted
    expect(await inner.count()).toBe(0);
  });

  it('keeps errors when keepErrors is set even at rate 0', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new SamplingTelescopeStore(
      inner,
      { log: { rate: 0, keepErrors: true } },
      () => 0.99,
    );

    await store.record({ type: EntryType.Log, content: { level: 'error', message: 'boom' } });
    await store.record({ type: EntryType.Log, content: { level: 'log', message: 'noise' } });

    expect(await inner.count()).toBe(1);
    const [kept] = await inner.list();
    expect((kept?.content as { level: string }).level).toBe('error');
  });

  it('is a pass-through for reads', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new SamplingTelescopeStore(inner, { default: 1 });
    const recorded = await store.record({ type: EntryType.Request, content: {} });
    expect(await store.get(recorded.id)).not.toBeNull();
    expect(await store.count()).toBe(1);
  });
});
