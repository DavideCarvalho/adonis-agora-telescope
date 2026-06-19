import { EntryType, type RecordInput, currentTraceId } from '@agora/telescope';
import type { EmitterLike, Watcher } from './emitter.js';
import { queryFamilyHash } from './query_family_hash.js';
import { safeRecord } from './record.js';

/** The Lucid event name this watcher subscribes to. */
export const DB_QUERY_EVENT = 'db:query';

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
    safeRecord(buildQueryEntry(data), 'LucidQueryWatcher');
  }
}

/** Map a Lucid `db:query` payload to a telescope {@link RecordInput}. */
export function buildQueryEntry(event: DbQueryEventLike): RecordInput<QueryEntryContent> {
  const durationMs = hrtimeToMs(event.duration);
  const method = typeof event.method === 'string' ? event.method : null;
  const traceId = currentTraceId();
  const content: QueryEntryContent = {
    sql: event.sql,
    bindings: Array.isArray(event.bindings) ? event.bindings : [],
    durationMs,
    connection: event.connection,
    method,
    inTransaction: typeof event.inTransaction === 'boolean' ? event.inTransaction : null,
    traceId,
  };
  return {
    type: EntryType.Query,
    familyHash: queryFamilyHash(event.sql),
    content,
    durationMs,
    traceId,
    tags: [
      `connection:${event.connection}`,
      ...(method ? [`method:${method}`] : []),
      ...(event.model ? [`model:${event.model}`] : []),
    ],
  };
}
