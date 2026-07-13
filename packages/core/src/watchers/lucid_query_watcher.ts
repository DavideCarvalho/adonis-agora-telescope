import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import type { EmitterLike, Watcher } from './emitter.js';
import { queryFamilyHash } from './query_family_hash.js';
import { safeRecord } from './record.js';

/** The Lucid event name this watcher subscribes to. */
export const DB_QUERY_EVENT = 'db:query';

/** Placeholder a bound value is replaced with when `captureBindings` is off. */
const REDACTED = '[REDACTED]';

/** Default slow-query threshold (ms), mirrored from the resolved watcher config. */
const DEFAULT_SLOW_MS = 500;

/** Construction-time tuning for {@link LucidQueryWatcher} — the resolved slice of
 *  `config/telescope_watchers.ts`'s `query` block the watcher acts on. */
export interface LucidQueryWatcherOptions {
  /** Queries at/above this many ms get a `slow` tag. Default 500. */
  slowMs?: number;
  /** Keep the raw bound VALUES instead of redacting them. Default `false`. */
  captureBindings?: boolean;
  /** Connection names (case-insensitive) whose queries are not recorded. */
  ignoreConnections?: string[];
  /** Normalize SQL into the `familyHash` grouping key. Default `true`. */
  normalize?: boolean;
}

/**
 * The shape of the data `@adonisjs/lucid` emits on `db:query`. Mirrored
 * structurally from `@adonisjs/lucid`'s `DbQueryEventNode` (verified against the
 * installed `@adonisjs/lucid` types — `src/types/database.d.ts`) so the watcher
 * has no build-time dependency on Lucid. `duration` is a `process.hrtime()` tuple
 * `[seconds, nanoseconds]`.
 */
export interface DbQueryEventLike {
  connection: string;
  sql: string;
  method: string;
  bindings?: unknown[];
  duration?: [number, number];
  model?: string;
  ddl?: boolean;
  inTransaction?: boolean;
}

/** The recorded body of a `query` entry. */
export interface QueryEntryContent {
  /** The executed SQL. */
  sql: string;
  /** The bound parameter values, in order. */
  bindings: unknown[];
  /** Query duration in milliseconds, or `null` when Lucid did not report one. */
  durationMs: number | null;
  /** The Lucid connection name (e.g. `'primary'`). */
  connection: string;
  /** The query method (`'select'`, `'insert'`, …), or `null` when absent. */
  method: string | null;
  /** Whether the query ran inside a transaction, when Lucid reported it. */
  inTransaction: boolean | null;
  /** The active trace id at query time, or `null`. */
  traceId: string | null;
}

/** Convert a `process.hrtime()` `[seconds, nanoseconds]` tuple to milliseconds. */
function hrtimeToMs(duration: [number, number] | undefined): number | null {
  if (!Array.isArray(duration) || duration.length !== 2) return null;
  const [seconds, nanoseconds] = duration;
  if (typeof seconds !== 'number' || typeof nanoseconds !== 'number') return null;
  return seconds * 1000 + nanoseconds / 1e6;
}

/** Narrow an unknown emitter payload to a {@link DbQueryEventLike}. */
function isDbQueryEvent(data: unknown): data is DbQueryEventLike {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return typeof candidate.sql === 'string' && typeof candidate.connection === 'string';
}

/**
 * Records every SQL query Lucid executes as a `query` telescope entry — the
 * headline watcher of this package. It subscribes to Lucid's `db:query` event
 * (the same event `db.prettyPrint` consumes) and captures the SQL, bindings,
 * duration, and connection, correlated to the active request via the trace id.
 *
 * Recording is fire-and-forget and fully guarded: a telescope failure can never
 * break or block a query. Grouping is by SQL template (see
 * {@link queryFamilyHash}) so a dashboard can roll up "the same query".
 *
 * @remarks
 * Lucid only emits `db:query` when the connection's `debug` flag is on (or a
 * `db:query` listener exists at query-report start). Subscribing here is enough to
 * make Lucid report; enabling `debug` in your DB config guarantees it.
 */
export class LucidQueryWatcher implements Watcher {
  readonly type = EntryType.Query;
  private unsubscribe: (() => void) | null = null;
  private readonly slowMs: number;
  private readonly captureBindings: boolean;
  private readonly ignoreConnections: Set<string>;
  private readonly normalize: boolean;

  constructor(options: LucidQueryWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.captureBindings = options.captureBindings ?? false;
    this.ignoreConnections = new Set(
      (options.ignoreConnections ?? []).map((name) => name.toLowerCase()),
    );
    this.normalize = options.normalize ?? true;
  }

  start(emitter: EmitterLike): void {
    if (this.unsubscribe) return;
    this.unsubscribe = emitter.on(DB_QUERY_EVENT, (data) => this.handle(data));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Validate + record a single `db:query` payload, never throwing. */
  private handle(data: unknown): void {
    if (!isDbQueryEvent(data)) return;
    // An ignored connection is dropped before any work — a telescope query that
    // hits the store's own DB, a replica used only for the timeline, etc.
    if (this.ignoreConnections.has(data.connection.toLowerCase())) return;
    safeRecord(
      buildQueryEntry(data, {
        slowMs: this.slowMs,
        captureBindings: this.captureBindings,
        normalize: this.normalize,
      }),
      'LucidQueryWatcher',
    );
  }
}

/** Map a Lucid `db:query` payload to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without a running emitter. */
export function buildQueryEntry(
  event: DbQueryEventLike,
  options: LucidQueryWatcherOptions = {},
): RecordInput<QueryEntryContent> {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const captureBindings = options.captureBindings ?? false;
  const normalize = options.normalize ?? true;

  const durationMs = hrtimeToMs(event.duration);
  const method = typeof event.method === 'string' ? event.method : null;
  const traceId = currentTraceId();
  const rawBindings = Array.isArray(event.bindings) ? event.bindings : [];
  const content: QueryEntryContent = {
    sql: event.sql,
    // Redact bound VALUES by default (they carry PII/secrets) while preserving
    // arity, so the query's shape stays visible without leaking data.
    bindings: captureBindings ? rawBindings : rawBindings.map(() => REDACTED),
    durationMs,
    connection: event.connection,
    method,
    inTransaction: typeof event.inTransaction === 'boolean' ? event.inTransaction : null,
    traceId,
  };
  const tags: string[] = [
    `connection:${event.connection}`,
    ...(method ? [`method:${method}`] : []),
    ...(event.model ? [`model:${event.model}`] : []),
  ];
  if (durationMs !== null && durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.Query,
    // Group by SQL template (see queryFamilyHash) so "the same query" rolls up
    // for the Pulse slow-query + N+1 cards. `normalize: false` hashes verbatim.
    familyHash: normalize ? queryFamilyHash(event.sql) : queryFamilyHash(event.sql, false),
    content,
    durationMs,
    traceId,
    tags,
  };
}
