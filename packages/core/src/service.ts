import type { Entry } from './entry.js';
import type { EntryQuery, TelescopeStore } from './store.js';

/** A `{ familyHash | tag, count }` aggregate for top-N style summaries. */
export interface CountBucket {
  key: string;
  count: number;
}

/**
 * The headless query API over recorded entries — what a future dashboard, an
 * `inspector` endpoint, or your own controller reads. Thin facade over a
 * {@link TelescopeStore} with a couple of convenience aggregates the recorded
 * `tags`/`familyHash` make cheap.
 */
export class TelescopeService {
  constructor(private readonly store: TelescopeStore) {}

  /** The underlying store, for advanced callers (and the provider's shutdown). */
  get telescopeStore(): TelescopeStore {
    return this.store;
  }

  /** List entries matching `query`, newest-first. */
  list(query?: EntryQuery): Entry[] {
    return this.store.list(query);
  }

  /** Fetch one entry by id, or `null`. */
  find(id: string): Entry | null {
    return this.store.get(id);
  }

  /** Every entry recorded under a given trace id, newest-first. */
  byTrace(traceId: string): Entry[] {
    return this.store.list({ traceId });
  }

  /** Total number of stored entries. */
  count(): number {
    return this.store.count();
  }

  /**
   * Top-N busiest groups by `familyHash` (e.g. the busiest `lib:event` pairs, or
   * grouped exceptions), optionally scoped to a `type`. Newest data wins ties via
   * the store's newest-first ordering.
   */
  topFamilies(limit = 10, type?: string): CountBucket[] {
    const counts = new Map<string, number>();
    for (const entry of this.store.list(type !== undefined ? { type } : {})) {
      if (!entry.familyHash) continue;
      counts.set(entry.familyHash, (counts.get(entry.familyHash) ?? 0) + 1);
    }
    return toSortedBuckets(counts, limit);
  }

  /** Top-N most common tags across stored entries, optionally by prefix. */
  topTags(limit = 10, prefix?: string): CountBucket[] {
    const counts = new Map<string, number>();
    for (const entry of this.store.list()) {
      for (const tag of entry.tags) {
        if (prefix !== undefined && !tag.startsWith(prefix)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return toSortedBuckets(counts, limit);
  }
}

function toSortedBuckets(counts: Map<string, number>, limit: number): CountBucket[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
