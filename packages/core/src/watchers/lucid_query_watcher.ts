import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { clampRate, keepByTrace } from '../sampling/trace_sampler.js';
import type { EmitterLike, Watcher } from './emitter.js';
import { normalizeSql, queryFamilyHash } from './query_family_hash.js';
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
  /** SQL patterns whose queries are not recorded (see {@link QueryIgnoreMatcher}). */
  ignore?: Array<string | RegExp>;
  /** Tables whose queries are not recorded (see {@link QueryIgnoreMatcher}). */
  ignoreTables?: string[];
  /** Queries faster than this many ms are not recorded (slow and failed ones always are). Default 0. */
  minMs?: number;
  /** Fraction (0..1) of the not-slow, not-failed queries recorded, decided per trace. Default 1. */
  sampleRate?: number;
}

/** Ignore decisions cached per raw SQL string; bounded like the family-hash cache. */
const MAX_CACHED_DECISIONS = 2_000;
const MAX_CACHED_SQL_LENGTH = 4_096;

/** The table a statement reads or writes first: `select … from t`, `insert into t`, `update t`, `delete from t`. */
const PRIMARY_TABLE = /^(?:select\b.*?\bfrom|insert\s+into|update|delete\s+from)\s+([^\s(,;]+)/;

/** A table name without quoting, lowercased: `"public"."Users"` → `public.users`. */
function bareTable(name: string): string {
  return name.replace(/["`[\]]/g, '').toLowerCase();
}

/**
 * Decides which SQL statements the query watcher drops, against the normalized
 * template (lowercased, whitespace collapsed, literals replaced by `?`):
 * - `ignore`: a string matches as a PREFIX of the template (the pattern is normalized
 *   the same way, so case and spacing do not matter); a RegExp is tested against the
 *   template as-is.
 * - `ignoreTables`: the statement's primary table (the first `from` of a select, the
 *   target of an insert/update/delete), with or without its schema.
 *
 * Exported for tests. Decisions are cached per SQL string: an app runs the same few
 * hundred statements, so normalizing each one once keeps this off the hot path.
 */
export class QueryIgnoreMatcher {
  private readonly prefixes: string[];
  private readonly patterns: RegExp[];
  private readonly tables: Set<string>;
  private readonly decisions = new Map<string, boolean>();

  constructor(ignore: Array<string | RegExp> = [], ignoreTables: string[] = []) {
    this.prefixes = ignore.filter((p): p is string => typeof p === 'string').map(normalizeSql);
    this.patterns = ignore.filter((p): p is RegExp => p instanceof RegExp);
    this.tables = new Set(ignoreTables.map(bareTable));
  }

  /** Whether nothing is configured (the watcher then skips the check entirely). */
  get empty(): boolean {
    return this.prefixes.length === 0 && this.patterns.length === 0 && this.tables.size === 0;
  }

  ignores(sql: string): boolean {
    if (this.empty) return false;
    const cached = this.decisions.get(sql);
    if (cached !== undefined) return cached;
    const decision = this.decide(normalizeSql(sql));
    if (sql.length <= MAX_CACHED_SQL_LENGTH) {
      if (this.decisions.size >= MAX_CACHED_DECISIONS) this.decisions.clear();
      this.decisions.set(sql, decision);
    }
    return decision;
  }

  private decide(template: string): boolean {
    for (const prefix of this.prefixes) if (template.startsWith(prefix)) return true;
    for (const pattern of this.patterns) {
      // A /g or /y pattern keeps `lastIndex` between calls; reset it so each test starts fresh.
      pattern.lastIndex = 0;
      if (pattern.test(template)) return true;
    }
    if (this.tables.size > 0) {
      const table = PRIMARY_TABLE.exec(template)?.[1];
      if (table !== undefined) {
        const bare = bareTable(table);
        const unqualified = bare.slice(bare.lastIndexOf('.') + 1);
        if (this.tables.has(bare) || this.tables.has(unqualified)) return true;
      }
    }
    return false;
  }
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
  /** Set by Lucid when the query failed. */
  error?: unknown;
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
  /** The error message when the query failed; absent when it succeeded. */
  error?: string;
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
  private readonly ignore: QueryIgnoreMatcher;
  private readonly minMs: number;
  private readonly sampleRate: number;

  constructor(options: LucidQueryWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.captureBindings = options.captureBindings ?? false;
    this.ignoreConnections = new Set(
      (options.ignoreConnections ?? []).map((name) => name.toLowerCase()),
    );
    this.normalize = options.normalize ?? true;
    this.ignore = new QueryIgnoreMatcher(options.ignore, options.ignoreTables);
    this.minMs = Math.max(0, options.minMs ?? 0);
    this.sampleRate = clampRate(options.sampleRate);
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
    if (this.ignore.ignores(data.sql)) return;
    if (!this.keeps(data)) return;
    safeRecord(
      () =>
        buildQueryEntry(data, {
          slowMs: this.slowMs,
          captureBindings: this.captureBindings,
          normalize: this.normalize,
        }),
      'LucidQueryWatcher',
    );
  }

  /**
   * The volume knobs: a failed query and a slow one are always kept; below `minMs`
   * a query is dropped; the rest are kept for `sampleRate` of the traces. A query
   * with no reported duration is never dropped by `minMs`.
   */
  private keeps(data: DbQueryEventLike): boolean {
    if (this.minMs === 0 && this.sampleRate >= 1) return true;
    if (data.error !== undefined && data.error !== null) return true;
    const durationMs = hrtimeToMs(data.duration);
    if (durationMs !== null) {
      if (durationMs >= this.slowMs) return true;
      if (durationMs < this.minMs) return false;
    }
    return keepByTrace(currentTraceId(), this.sampleRate);
  }
}

/** The message of a Lucid query error, whatever shape it was thrown in. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
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
  const failed = event.error !== undefined && event.error !== null;
  if (failed) content.error = errorMessage(event.error);
  const tags: string[] = [
    `connection:${event.connection}`,
    ...(method ? [`method:${method}`] : []),
    ...(event.model ? [`model:${event.model}`] : []),
  ];
  if (durationMs !== null && durationMs >= slowMs) tags.push('slow');
  if (failed) tags.push('failed');

  let familyHash: string | undefined;
  return {
    type: EntryType.Query,
    // Group by SQL template (see queryFamilyHash) so "the same query" rolls up
    // for the Pulse slow-query + N+1 cards. `normalize: false` hashes verbatim.
    // Computed on first read, which a sampled-out entry never gets to: templating
    // a large statement costs more than the rest of the entry.
    get familyHash() {
      familyHash ??= queryFamilyHash(event.sql, normalize);
      return familyHash;
    },
    content,
    durationMs,
    traceId,
    tags,
  };
}
