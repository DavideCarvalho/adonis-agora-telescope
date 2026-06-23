import type { Entry, RecordInput } from '../entry.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import { type SamplingConfig, passesSampling } from './sampling.js';

/**
 * A {@link TelescopeStore} decorator that applies tail-sampling on the WRITE
 * path: a dropped entry is NEVER persisted (its `record()` short-circuits before
 * delegating to the inner store). Wiring sampling at the store boundary — the one
 * place every watcher records through — guarantees no watcher can bypass it.
 *
 * The decision is made by the pure {@link passesSampling} using only the shallow
 * fields already on the {@link RecordInput} (no deep walk), so the hot path stays
 * cheap. The RNG is injected so the decision is deterministic in tests.
 *
 * Default-neutral: with an empty {@link SamplingConfig} (the default when the
 * host sets no `sampling` option) every entry passes, so behavior is unchanged.
 *
 * A DROPPED entry still resolves to a synthetic {@link Entry} (never persisted,
 * `sequence: -1`) so the fire-and-forget `record()` contract — callers `void` the
 * promise — is honoured without surfacing the drop as an error.
 */
export class SamplingTelescopeStore implements TelescopeStore {
  constructor(
    private readonly inner: TelescopeStore,
    private readonly sampling: SamplingConfig,
    private readonly random: () => number = Math.random,
  ) {}

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    if (!passesSampling(this.sampling, input, this.random)) {
      return droppedEntry(input);
    }
    return this.inner.record(input);
  }

  get(id: string): Promise<Entry | null> {
    return this.inner.get(id);
  }

  list(query?: EntryQuery): Promise<Entry[]> {
    return this.inner.list(query);
  }

  count(): Promise<number> {
    return this.inner.count();
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.inner.prune(olderThan, keepLast);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }
}

/** A non-persisted placeholder for a sampled-away entry (`sequence: -1`). */
function droppedEntry<TContent>(input: RecordInput<TContent>): Entry<TContent> {
  return {
    id: '',
    type: input.type,
    familyHash: input.familyHash ?? null,
    content: input.content,
    tags: input.tags ?? [],
    sequence: -1,
    durationMs: input.durationMs ?? null,
    origin: input.origin ?? 'manual',
    traceId: input.traceId ?? null,
    createdAt: new Date(),
  };
}
