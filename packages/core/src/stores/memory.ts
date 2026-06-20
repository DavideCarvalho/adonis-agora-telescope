import { randomUUID } from 'node:crypto';
import { currentTraceId } from '../context_accessor.js';
import { type BatchOrigin, type Entry, type RecordInput, isBatchOrigin } from '../entry.js';
import type { EntryQuery, TelescopeStore } from '../store.js';

/** Options for {@link InMemoryTelescopeStore}. */
export interface InMemoryStoreOptions {
  /**
   * Hard cap on retained entries. When exceeded, the oldest entries are evicted
   * (ring-buffer semantics) so an unbounded process can never OOM. Default 1000.
   */
  maxEntries?: number;
}

/**
 * The default, dependency-free {@link TelescopeStore}: a bounded in-process ring
 * buffer. Ideal for development and tests; production deployments that need
 * cross-process or durable storage swap in the `lucid` driver (or any store
 * implementing the same contract).
 */
export class InMemoryTelescopeStore implements TelescopeStore {
  private readonly maxEntries: number;
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private sequence = 0;

  constructor(options: InMemoryStoreOptions = {}) {
    const max = options.maxEntries ?? 1000;
    this.maxEntries = max > 0 ? max : 1000;
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const traceId = input.traceId !== undefined ? input.traceId : currentTraceId();
    const origin: BatchOrigin = isBatchOrigin(input.origin) ? input.origin : 'manual';
    const entry: Entry<TContent> = {
      id: randomUUID(),
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: input.content,
      tags: input.tags ?? [],
      sequence: this.sequence++,
      durationMs: input.durationMs ?? null,
      origin,
      traceId,
      createdAt: new Date(),
    };

    // Newest-first ordering: unshift so index 0 is always the most recent.
    this.entries.unshift(entry as Entry);
    this.byId.set(entry.id, entry as Entry);
    this.evictOverflow();
    return entry;
  }

  async get(id: string): Promise<Entry | null> {
    return this.byId.get(id) ?? null;
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    const search = query.search?.toLowerCase();
    const results: Entry[] = [];
    // `entries` is already newest-first.
    for (const entry of this.entries) {
      if (query.type !== undefined && entry.type !== query.type) continue;
      if (query.tag !== undefined && !entry.tags.includes(query.tag)) continue;
      if (query.familyHash !== undefined && entry.familyHash !== query.familyHash) continue;
      if (query.traceId !== undefined && entry.traceId !== query.traceId) continue;
      if (query.before !== undefined && !(entry.createdAt < query.before)) continue;
      if (query.after !== undefined && !(entry.createdAt > query.after)) continue;
      if (search !== undefined && !matchesSearch(entry, search)) continue;
      results.push(entry);
      if (query.limit !== undefined && results.length >= query.limit) break;
    }
    return results;
  }

  async count(): Promise<number> {
    return this.entries.length;
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    // Indices of the doomed entries (older than the cutoff), newest-first.
    const doomed: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry && entry.createdAt < olderThan) doomed.push(i);
    }
    // Keep the newest N of the doomed set: since `entries` is newest-first, the
    // first `keepLast` doomed indices are the newest doomed ones.
    const toDelete = keepLast !== undefined ? doomed.slice(keepLast) : doomed;
    if (toDelete.length === 0) return 0;
    // Delete from the back so earlier indices stay valid.
    const ascending = [...toDelete].sort((a, b) => b - a);
    for (const index of ascending) {
      const [removed] = this.entries.splice(index, 1);
      if (removed) this.byId.delete(removed.id);
    }
    return toDelete.length;
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
    this.byId.clear();
  }

  private evictOverflow(): void {
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.pop();
      if (removed) this.byId.delete(removed.id);
    }
  }
}

/** Substring match against the entry's JSON content and its tags. */
function matchesSearch(entry: Entry, needle: string): boolean {
  if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) return true;
  try {
    return JSON.stringify(entry.content).toLowerCase().includes(needle);
  } catch {
    // Content with a circular reference / BigInt — fall back to no match.
    return false;
  }
}
