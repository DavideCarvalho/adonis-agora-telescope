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
  /** Cap the number of returned entries. */
  limit?: number;
  /**
   * Skip this many entries before returning, for offset pagination. Applied AFTER
   * ordering (newest-first), so `{ limit: 25, offset: 25 }` is the second page.
   */
  offset?: number;
}

/** One row of {@link TelescopeStore.listTraceIds} — a trace and when it was last seen. */
export interface TraceIdRow {
  traceId: string;
  /** The newest `createdAt` among the trace's entries. */
  lastAt: Date;
}

/** The window + page for {@link TelescopeStore.listTraceIds}. */
export interface TraceIdQuery {
  /** How many trace ids to return. */
  limit: number;
  /** How many to skip, for offset pagination. */
  offset?: number;
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
}
