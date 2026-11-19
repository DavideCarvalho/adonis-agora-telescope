import type { Entry, RecordInput } from '../entry.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  DurationQuery,
  DurationRow,
  EntryQuery,
  FamilyCountQuery,
  KeyCountRow,
  SlowestQuery,
  TagCountQuery,
  TelescopeStore,
  TraceIdRow,
  TracePageQuery,
  TraceRepeatQuery,
  TraceRepeatRow,
} from '../store.js';

/** Why a write on another app's store is refused. */
export const FEDERATED_READ_ONLY = "Another app's telescope store is only read from this console.";

/** The bounds {@link FederatedReadStore} puts on every read of another app's store. */
export interface FederatedReadLimits {
  /**
   * The longest window an aggregate (throughput, Pulse cards, a list with no page size) covers, in
   * ms: an older `after` is moved up to `before - maxWindowMs`. Default 24 h.
   */
  maxWindowMs?: number;
  /**
   * How far back a filtered list with no lower bound looks (a search, a tag filter): its `after`
   * becomes `now - searchWindowMs`, so the database reads one window of the time index, never the
   * whole table. Default 24 h.
   */
  searchWindowMs?: number;
  /** Most rows a read with no page size returns (and the sample counts are computed over). Default 5,000. */
  maxRows?: number;
  /** Reads running at once against this store; the rest wait their turn. Default 4. */
  maxConcurrentReads?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export const DEFAULT_FEDERATED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FEDERATED_MAX_ROWS = 5_000;
export const DEFAULT_FEDERATED_CONCURRENCY = 4;

/**
 * Another app's telescope store, as a console reads it: only reads, and only bounded ones.
 *
 * - writes (`record`, `prune`, `clear`) are refused: the owning app records and prunes its entries;
 * - every read walks an index the store already has (`created_at`, `type + created_at`,
 *   `family_hash + created_at`, `trace_id`, the primary key) and stops at a page size or a window:
 *   a list with no page size gets {@link FederatedReadLimits.maxRows}, a search or tag filter with no
 *   lower bound gets {@link FederatedReadLimits.searchWindowMs}, an aggregate over a window longer
 *   than {@link FederatedReadLimits.maxWindowMs} is cut to it;
 * - the whole-table reads (`count`, top families, top tags, `listTraceIds`'s `GROUP BY trace_id`)
 *   are answered from the newest {@link FederatedReadLimits.maxRows} entries instead;
 * - at most {@link FederatedReadLimits.maxConcurrentReads} queries run at once.
 */
export class FederatedReadStore implements TelescopeStore {
  // The windowed fast paths, set in the constructor when the inner store has them.
  declare readonly countByBucket?: NonNullable<TelescopeStore['countByBucket']>;
  declare readonly listSlowest?: NonNullable<TelescopeStore['listSlowest']>;
  declare readonly countTraceRepeats?: NonNullable<TelescopeStore['countTraceRepeats']>;
  declare readonly listDurations?: NonNullable<TelescopeStore['listDurations']>;
  declare readonly pageTraceIds?: NonNullable<TelescopeStore['pageTraceIds']>;
  readonly honorsTagGroups: boolean;
  private readonly maxWindowMs: number;
  private readonly searchWindowMs: number;
  private readonly maxRows: number;
  private readonly now: () => number;
  private readonly gate: Semaphore;

  constructor(
    private readonly inner: TelescopeStore,
    limits: FederatedReadLimits = {},
  ) {
    this.maxWindowMs = positive(limits.maxWindowMs, DEFAULT_FEDERATED_WINDOW_MS);
    this.searchWindowMs = positive(limits.searchWindowMs, DEFAULT_FEDERATED_WINDOW_MS);
    this.maxRows = Math.floor(positive(limits.maxRows, DEFAULT_FEDERATED_MAX_ROWS));
    this.now = limits.now ?? Date.now;
    this.gate = new Semaphore(
      Math.floor(positive(limits.maxConcurrentReads, DEFAULT_FEDERATED_CONCURRENCY)),
    );
    this.honorsTagGroups = inner.honorsTagGroups === true;
    const self = this as unknown as Record<string, unknown>;
    // The windowed fast paths, with the window cut to `maxWindowMs`. The whole-table ones
    // (`listTraceIds`, `countFamilies`, `countTags`) are not forwarded: see the methods below.
    if (typeof inner.countByBucket === 'function') {
      const countByBucket = inner.countByBucket.bind(inner);
      self.countByBucket = (query: BucketCountQuery) =>
        this.countByBucketBounded(query, countByBucket);
    }
    if (typeof inner.listSlowest === 'function') {
      const listSlowest = inner.listSlowest.bind(inner);
      self.listSlowest = (query: SlowestQuery): Promise<Entry[]> =>
        this.read(() =>
          listSlowest({ ...query, after: this.windowStart(query.after, query.before) }),
        );
    }
    if (typeof inner.countTraceRepeats === 'function') {
      const countTraceRepeats = inner.countTraceRepeats.bind(inner);
      self.countTraceRepeats = (query: TraceRepeatQuery): Promise<TraceRepeatRow[]> =>
        this.read(() =>
          countTraceRepeats({ ...query, after: this.windowStart(query.after, query.before) }),
        );
    }
    if (typeof inner.listDurations === 'function') {
      const listDurations = inner.listDurations.bind(inner);
      self.listDurations = (query: DurationQuery): Promise<DurationRow[]> =>
        this.read(() =>
          listDurations({
            ...query,
            after: this.windowStart(query.after, query.before),
            limit: Math.min(query.limit, this.maxRows),
          }),
        );
    }
    if (typeof inner.pageTraceIds === 'function') {
      // A keyset walk from the newest entry (or the cursor) that stops once it has the page.
      const pageTraceIds = inner.pageTraceIds.bind(inner);
      self.pageTraceIds = (query: TracePageQuery): Promise<TraceIdRow[]> =>
        this.read(() => pageTraceIds({ ...query, size: Math.min(query.size, this.maxRows) }));
    }
  }

  record<TContent>(_input?: RecordInput<TContent>): Promise<Entry<TContent>> {
    return Promise.reject(new Error(FEDERATED_READ_ONLY));
  }

  prune(_olderThan?: Date, _keepLast?: number): Promise<number> {
    return Promise.reject(new Error(FEDERATED_READ_ONLY));
  }

  clear(): Promise<void> {
    return Promise.reject(new Error(FEDERATED_READ_ONLY));
  }

  get(id: string): Promise<Entry | null> {
    return this.read(() => this.inner.get(id));
  }

  list(query: EntryQuery = {}): Promise<Entry[]> {
    return this.read(() => this.inner.list(this.bound(query)));
  }

  /** The entries among the newest {@link FederatedReadLimits.maxRows}: a lower bound, never a table count. */
  async count(): Promise<number> {
    return (await this.list({ omitContent: true })).length;
  }

  /** The busiest families among the newest entries (see {@link count}). */
  async countFamilies(query: FamilyCountQuery): Promise<KeyCountRow[]> {
    const sample = await this.list({
      omitContent: true,
      ...(query.type !== undefined ? { type: query.type } : {}),
    });
    return topKeys(
      sample.map((entry) => (entry.familyHash ? [entry.familyHash] : [])),
      query.limit,
    );
  }

  /** The most common tags among the newest entries (see {@link count}). */
  async countTags(query: TagCountQuery): Promise<KeyCountRow[]> {
    const sample = await this.list({ omitContent: true });
    return topKeys(
      sample.map((entry) =>
        query.prefix === undefined
          ? entry.tags
          : entry.tags.filter((tag) => tag.startsWith(query.prefix as string)),
      ),
      query.limit,
    );
  }

  /**
   * `query`, made bounded: a page size (or `maxRows`), and a lower time bound for the filters
   * no index answers (`search`, `tag`, `anyTags`) and for unpaged reads. A read by trace (an
   * index) keeps its shape, capped at `maxRows`.
   */
  private bound(query: EntryQuery): EntryQuery {
    const out: EntryQuery = { ...query };
    const byTrace = query.traceId !== undefined || query.traceIds !== undefined;
    const unpaged = query.size === undefined || !(query.size > 0);
    if (unpaged) {
      out.size = this.maxRows;
      delete out.page;
    } else {
      out.size = Math.min(Math.floor(query.size as number), this.maxRows);
    }
    if (byTrace) return out;
    const scansText =
      query.search !== undefined || query.tag !== undefined || query.anyTags !== undefined;
    if (scansText || unpaged) {
      const before = query.before?.getTime() ?? this.now();
      const floor = before - (scansText ? this.searchWindowMs : this.maxWindowMs);
      if (query.after === undefined || query.after.getTime() < floor) out.after = new Date(floor);
    }
    return out;
  }

  /** `after`, moved up so the window is at most `maxWindowMs` long. */
  private windowStart(after: Date, before: Date): Date {
    const floor = before.getTime() - this.maxWindowMs;
    return after.getTime() < floor ? new Date(floor) : after;
  }

  /**
   * The bucket counts of the last `maxWindowMs` of the window. Bucket indices count from the
   * caller's `after`, so the cut moves by whole buckets and the indices are shifted back.
   */
  private countByBucketBounded(
    query: BucketCountQuery,
    countByBucket: (query: BucketCountQuery) => Promise<BucketCountRow[]>,
  ): Promise<BucketCountRow[]> {
    const bucketMs = Math.max(1, Math.floor(query.bucketMs));
    const span = query.before.getTime() - query.after.getTime();
    const skip = span > this.maxWindowMs ? Math.ceil((span - this.maxWindowMs) / bucketMs) : 0;
    if (skip === 0) return this.read(() => countByBucket(query));
    const after = new Date(query.after.getTime() + skip * bucketMs);
    return this.read(async () =>
      (await countByBucket({ ...query, after })).map((row) => ({
        ...row,
        index: row.index + skip,
      })),
    );
  }

  private read<T>(run: () => Promise<T>): Promise<T> {
    return this.gate.run(run);
  }
}

/** The `limit` most frequent keys, ties to the key seen first (the newest). */
function topKeys(rows: readonly (readonly string[])[], limit: number): KeyCountRow[] {
  const counts = new Map<string, number>();
  for (const keys of rows) for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(([key, count]) => ({ key, count }));
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** At most `size` tasks at once; the rest wait in arrival order. */
class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.running -= 1;
    }
  }
}
