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
}
