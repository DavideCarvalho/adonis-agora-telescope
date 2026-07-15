import type { Entry } from './entry.js';
import {
  type PulseQuery,
  PulseService,
  type PulseServiceOptions,
  type PulseSummary,
} from './metrics/pulse.js';
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
  /** Lazily-built pulse aggregator over the store (created on first `getHealth`). */
  private pulseService: PulseService | null = null;

  constructor(
    private readonly store: TelescopeStore,
    /** Defaults for the {@link getHealth} pulse rollup (window, cards, top-N). */
    private readonly pulseOptions: PulseServiceOptions = {},
  ) {}

  /** The underlying store, for advanced callers (and the provider's shutdown). */
  get telescopeStore(): TelescopeStore {
    return this.store;
  }

  /**
   * The aggregated "at a glance" health rollup (slowest entries, error rate,
   * throughput, top exceptions, cache hit ratio, slow route/outgoing/job
   * hotspots, N+1, load-by-user) over a trailing window. Reads the store on
   * demand through a {@link PulseService}; `query.windowMs` overrides the
   * configured default for a single call.
   */
  getHealth(query?: PulseQuery): Promise<PulseSummary> {
    this.pulseService ??= new PulseService(this.store, this.pulseOptions);
    return this.pulseService.getHealth(query ?? {});
  }

  /** List entries matching `query`, newest-first. */
  list(query?: EntryQuery): Promise<Entry[]> {
    return this.store.list(query);
  }

  /** Fetch one entry by id, or `null`. */
  find(id: string): Promise<Entry | null> {
    return this.store.get(id);
  }

  /** Every entry recorded under a given trace id, newest-first. */
  byTrace(traceId: string): Promise<Entry[]> {
    return this.store.list({ traceId });
  }

  /** Total number of stored entries. */
  count(): Promise<number> {
    return this.store.count();
  }

  /**
   * Top-N busiest groups by `familyHash` (e.g. the busiest `lib:event` pairs, or
   * grouped exceptions), optionally scoped to a `type`. Newest data wins ties via
   * the store's newest-first ordering.
   */
  async topFamilies(limit = 10, type?: string): Promise<CountBucket[]> {
    const counts = new Map<string, number>();
    for (const entry of await this.store.list(type !== undefined ? { type } : {})) {
      if (!entry.familyHash) continue;
      counts.set(entry.familyHash, (counts.get(entry.familyHash) ?? 0) + 1);
    }
    return toSortedBuckets(counts, limit);
  }

  /** Top-N most common tags across stored entries, optionally by prefix. */
  async topTags(limit = 10, prefix?: string): Promise<CountBucket[]> {
    const counts = new Map<string, number>();
    for (const entry of await this.store.list()) {
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
