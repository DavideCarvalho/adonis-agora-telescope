import type { Entry, RecordInput } from './entry.js';

/**
 * A filter for {@link TelescopeStore.list}. Every set field is an AND predicate,
 * so they compose. Results are always returned newest-first.
 */
export interface EntryQuery {
  /** Only entries of this type (e.g. `request`, `diagnostic`). */
  type?: string;
  /** Only entries carrying this exact tag (e.g. `lib:billing`). */
  tag?: string;
  /**
   * Only entries carrying AT LEAST ONE of these exact tags (an OR, unlike `tag`). An empty list
   * matches nothing. Used to scope a console to some tenants (`tenant:<id>` tags).
   */
  anyTags?: string[];
  /** Only entries with this grouping key. */
  familyHash?: string;
  /** Only entries recorded under this trace id. */
  traceId?: string;
  /**
   * Only entries recorded under ANY of these trace ids. Exists so a page of traces
   * can be hydrated with ONE query instead of one per trace: the traces screen picks
   * its page of ids first (see {@link TelescopeStore.listTraceIds}) and then fetches
   * exactly those entries. Composes with `traceId` as an additional constraint.
   */
  traceIds?: string[];
  /** Only entries strictly older than this instant (keyset-ish pagination). */
  before?: Date;
  /** Only entries newer than this instant. */
  after?: Date;
  /**
   * Case-insensitive substring matched against the entry's JSON-serialized
   * `content` and its `tags` — a request matches by url, a diagnostic by event,
   * etc. Composes with every other filter.
   */
  search?: string;
  /**
   * 1-based page number for offset pagination (default `1`). The skipped rows are
   * computed as `(page - 1) * size` by each store, counted over MATCHES and applied
   * AFTER ordering (newest-first), so `{ page: 2, size: 25 }` is the second page.
   *
   * Mirrors `@adonis-agora/filter`'s `FilterInput.page` ON PURPOSE: every
   * `@adonis-agora/*` library exposes the same `{ page, size }` pagination shape.
   * Structural match only — filter is deliberately NOT a dependency here.
   */
  page?: number;
  /**
   * Page size — the maximum number of entries returned. Mirrors
   * `@adonis-agora/filter`'s `FilterInput.size` (see {@link EntryQuery.page}).
   */
  size?: number;
  /**
   * The caller reads everything but `content`, so a store MAY return `content: null`
   * instead of loading and parsing it. A hint, not a filter: a store that ignores it
   * still answers correctly, and callers must not depend on content being absent.
   * Aggregations over a whole window set it and fetch the content of the few entries
   * they display afterwards.
   */
  omitContent?: boolean;
  /**
   * The caller reads only these top-level fields of `content`, so a store MAY return a
   * `content` holding just them (a field absent from the stored content stays absent).
   * A hint like {@link omitContent}: a store that ignores it returns the whole content,
   * which answers the same. Ignored when `omitContent` is set.
   */
  contentFields?: string[];
}

/**
 * Entries must carry, for EACH group, at least one of its tags (an AND of ORs) — how a console
 * view narrowed to some organizations and apps reaches the aggregate reads below. A store
 * honors it only when it declares {@link TelescopeStore.honorsTagGroups}; an empty group
 * matches nothing.
 */
export type TagGroups = readonly (readonly string[])[];

/** One row of {@link TelescopeStore.listTraceIds} — a trace and when it was last seen. */
export interface TraceIdRow {
  traceId: string;
  /** The newest `createdAt` among the trace's entries. */
  lastAt: Date;
}

/** One `(bucket, type)` tally from {@link TelescopeStore.countByBucket}. */
export interface BucketCountRow {
  /** Zero-based bucket index, counted from `after` in `bucketMs` steps. */
  index: number;
  type: string;
  count: number;
}

/** The window and bucket size for {@link TelescopeStore.countByBucket}. */
export interface BucketCountQuery {
  /** Window start (exclusive), the origin bucket indices are counted from. */
  after: Date;
  /** Window end (inclusive). */
  before: Date;
  /** Bucket width in ms. */
  bucketMs: number;
  /** Only entries of this type. */
  type?: string;
  /** Only entries inside these tag groups (see {@link TagGroups}). */
  tagGroups?: TagGroups;
}

/** What {@link TelescopeStore.listSlowest} reads. */
export interface SlowestQuery {
  /** Window start (exclusive). */
  after: Date;
  /** Window end (inclusive). */
  before: Date;
  /** How many entries to return. */
  limit: number;
  /** Only entries inside these tag groups (see {@link TagGroups}). */
  tagGroups?: TagGroups;
}

/** What {@link TelescopeStore.listDurations} reads. */
export interface DurationQuery {
  /** Window start (exclusive). */
  after: Date;
  /** Window end (inclusive). */
  before: Date;
  /** Only entries of this type. */
  type: string;
  /** Only entries whose `familyHash` starts with one of these (all families when omitted). */
  familyPrefixes?: readonly string[];
  /** At most this many rows, newest first. */
  limit: number;
  /** Only entries inside these tag groups (see {@link TagGroups}). */
  tagGroups?: TagGroups;
}

/** One timed entry from {@link TelescopeStore.listDurations}. */
export interface DurationRow {
  familyHash: string;
  durationMs: number;
}

/** What {@link TelescopeStore.countTraceRepeats} counts. */
export interface TraceRepeatQuery {
  /** Window start (exclusive). */
  after: Date;
  /** Window end (inclusive). */
  before: Date;
  /** Only entries of this type. */
  type: string;
  /** Only `(trace, family)` pairs seen at least this many times. */
  minCount: number;
  /** Only entries inside these tag groups (see {@link TagGroups}). */
  tagGroups?: TagGroups;
}

/** One `(trace, family)` pair from {@link TelescopeStore.countTraceRepeats}. */
export interface TraceRepeatRow {
  traceId: string;
  familyHash: string;
  /** Entries of the family in the trace. */
  count: number;
  /** Sum of their `durationMs` (entries without one count as 0). */
  totalDurationMs: number;
  /** The newest `createdAt` among them, in epoch ms. */
  lastAt: number;
}

/** A grouping key and how many stored entries carry it. */
export interface KeyCountRow {
  key: string;
  count: number;
}

/** What {@link TelescopeStore.countFamilies} counts. */
export interface FamilyCountQuery {
  /** How many families to return, busiest first. */
  limit: number;
  /** Only entries of this type. */
  type?: string;
}

/** What {@link TelescopeStore.countTags} counts. */
export interface TagCountQuery {
  /** How many tags to return, most common first. */
  limit: number;
  /** Only tags starting with this prefix. */
  prefix?: string;
}

/** The window + page for {@link TelescopeStore.listTraceIds}. */
export interface TraceIdQuery {
  /**
   * Page size — how many trace ids to return. Mirrors `@adonis-agora/filter`'s
   * `FilterInput.size` (structural match, not a dependency), like {@link EntryQuery}.
   */
  size: number;
  /** 1-based page number (default `1`); the store skips `(page - 1) * size` rows. */
  page?: number;
  /** Only traces with an entry strictly older than this instant. */
  before?: Date;
  /** Only traces with an entry newer than this instant. */
  after?: Date;
}

/**
 * The storage abstraction Telescope records through and the headless query API
 * reads from. Adapted from `nestjs-telescope`'s `StorageProvider`, trimmed to the
 * headless slice (no rollups, keyset cursors, or family-seen alerting — those are
 * deferred, see DESIGN.md). A future `@adonis-agora/telescope-lucid` / SQLite store
 * implements this same contract.
 */
export interface TelescopeStore {
  /**
   * Record one entry from a watcher's {@link RecordInput}, filling in `id`,
   * `sequence`, `createdAt` and resolving `traceId`/`origin` from context when the
   * caller omits them. Resolves to the persisted {@link Entry}.
   */
  record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>>;

  /** Fetch a single entry by id, or `null` when absent. */
  get(id: string): Promise<Entry | null>;

  /** List entries matching `query`, newest-first. */
  list(query?: EntryQuery): Promise<Entry[]>;

  /** Total number of stored entries. */
  count(): Promise<number>;

  /**
   * Delete entries older than `olderThan`. When `keepLast` is set, the newest N of
   * the matched-and-doomed entries are retained. Resolves to the number deleted.
   */
  prune(olderThan: Date, keepLast?: number): Promise<number>;

  /** Delete every stored entry. */
  clear(): Promise<void>;

  /**
   * OPTIONAL fast path for the traces screen: the page of distinct trace ids,
   * ordered by most-recently-seen, WITHOUT loading their entries.
   *
   * Why it exists: summarizing traces means grouping entries by `traceId`, and doing
   * that in JS requires loading every candidate entry first. On a real table (500k+
   * rows, dominated by whichever watcher is chattiest) asking for 80 traces meant
   * reading 50k rows and discarding 99% of them. A store backed by SQL can answer
   * this with `GROUP BY trace_id ORDER BY MAX(created_at) DESC LIMIT/OFFSET`, which
   * is an index walk instead of a scan.
   *
   * OPTIONAL, and that is deliberate: it is a capability, not a requirement. A store
   * that does not implement it (including any third-party one written before this
   * existed) keeps working — the metrics service falls back to scan-and-group, which
   * is correct, just slower.
   */
  listTraceIds?(query: TraceIdQuery): Promise<TraceIdRow[]>;

  /**
   * OPTIONAL fast path for the throughput chart: per-bucket, per-type COUNTS,
   * without loading the entries.
   *
   * The chart needs exactly two fields — `createdAt` and `type` — but the only way
   * to get them was `list()`, which selects whole rows including the `content` JSON
   * blob. Drawing sixty bars meant shipping every entry in the window out of the
   * database and parsing each one, to then throw all of it away except a timestamp
   * and a string.
   *
   * OPTIONAL, like {@link listTraceIds}: a store without it falls back to
   * scan-and-bucket, which is what this always used to do.
   */
  countByBucket?(query: BucketCountQuery): Promise<BucketCountRow[]>;

  /**
   * OPTIONAL fast path for `TelescopeService.topFamilies`: the busiest `familyHash`
   * values across every stored entry, most entries first, ties going to the family
   * seen most recently. Without it the service lists the whole table and counts in JS.
   */
  countFamilies?(query: FamilyCountQuery): Promise<KeyCountRow[]>;

  /**
   * OPTIONAL fast path for `TelescopeService.topTags`: the most common tags across
   * every stored entry, ties going to the tag seen most recently. Without it the
   * service lists the whole table and counts in JS.
   */
  countTags?(query: TagCountQuery): Promise<KeyCountRow[]>;

  /**
   * OPTIONAL fast path for the Pulse "slowest" card: the `limit` entries of the window
   * with the largest `durationMs` (entries without one excluded), slowest first, ties in
   * ascending id order. `content` may be omitted. Without it Pulse scans the window.
   */
  listSlowest?(query: SlowestQuery): Promise<Entry[]>;

  /**
   * OPTIONAL fast path for the Pulse N+1 card: per `(traceId, familyHash)` pair of
   * entries of `type` in the window (both non-null), how many there are, when at least
   * `minCount`. Without it Pulse scans the window and groups in JS.
   */
  countTraceRepeats?(query: TraceRepeatQuery): Promise<TraceRepeatRow[]>;

  /**
   * OPTIONAL fast path for the Pulse "slowest jobs" card: the `familyHash` and `durationMs` of
   * the entries of `type` in the window that have both, newest first, at most `limit`. Nothing
   * else of the row is read, so a covering index answers it. Without it Pulse lists the entries.
   */
  listDurations?(query: DurationQuery): Promise<DurationRow[]>;

  /**
   * Whether {@link countByBucket}, {@link listSlowest}, {@link countTraceRepeats} and
   * {@link listDurations} honor
   * a query's `tagGroups`. A view narrowed to some tenants or apps uses those fast paths
   * only when this is `true`: a store that ignored the groups would count entries the
   * viewer may not see.
   */
  readonly honorsTagGroups?: boolean;
}

/** The optional read methods a store may implement on top of the required contract. */
const OPTIONAL_READS = [
  'listTraceIds',
  'countByBucket',
  'countFamilies',
  'countTags',
  'listSlowest',
  'countTraceRepeats',
  'listDurations',
] as const;

/**
 * Give a decorating store the optional read methods its inner store has, and only
 * those: callers detect a capability by the method being there, so a decorator that
 * always declared them would claim fast paths the store underneath cannot serve, and
 * one that never did would hide them.
 */
export function forwardOptionalReads(target: TelescopeStore, inner: TelescopeStore): void {
  const writable = target as unknown as Record<string, unknown>;
  for (const name of OPTIONAL_READS) {
    const method = inner[name];
    if (typeof method === 'function') writable[name] = method.bind(inner);
  }
  if (inner.honorsTagGroups === true) writable.honorsTagGroups = true;
}
