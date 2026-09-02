import { createHash, randomUUID } from 'node:crypto';
import { currentTraceId } from '../context_accessor.js';
import { type BatchOrigin, type Entry, isBatchOrigin, type RecordInput } from '../entry.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  TelescopeStore,
  TraceIdQuery,
  TraceIdRow,
} from '../store.js';

/**
 * The table {@link LucidTelescopeStore} reads and writes. Override via
 * {@link LucidStoreOptions.tableName} when `telescope_entries` collides with an
 * existing table.
 */
export const DEFAULT_TABLE_NAME = 'telescope_entries';

/**
 * The column layout, kept in one place so the DDL helper, the migration stub and
 * the store's queries can never drift apart.
 *
 * - `content` / `tags` are JSON text columns (portable across every Lucid dialect).
 * - `family_hash` is the grouping key used by `topFamilies`; `trace_id` powers
 *   trace correlation; `created_at` is stored as epoch milliseconds so newest-first
 *   ordering and age-based pruning are a plain integer comparison (no timezone or
 *   string-format ambiguity across drivers).
 */
export interface TelescopeColumns {
  id: string;
  type: string;
  family_hash: string | null;
  content: string;
  tags: string;
  sequence: number;
  duration_ms: number | null;
  origin: string;
  trace_id: string | null;
  created_at: number;
}

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the telescope entries table, plus the
 * indexes `list` / `prune` / `topFamilies` lean on, as one statement per array
 * element so each can be issued through Lucid's `rawQuery`.
 *
 * Portable across sqlite / Postgres / MySQL (quoted identifiers, no dialect-only
 * column types). A real deployment should still prefer the bundled migration stub
 * so the schema is versioned, but this lets a store stand itself up in tests and
 * scripts without a migration runner.
 */
export function createTableStatements(tableName: string = DEFAULT_TABLE_NAME): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS "${tableName}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "type" VARCHAR(255) NOT NULL,
      "family_hash" VARCHAR(255) NULL,
      "content" TEXT NOT NULL,
      "tags" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "duration_ms" INTEGER NULL,
      "origin" VARCHAR(255) NOT NULL,
      "trace_id" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_created_at_idx" ON "${tableName}" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_type_idx" ON "${tableName}" ("type")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_trace_id_idx" ON "${tableName}" ("trace_id")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_family_hash_idx" ON "${tableName}" ("family_hash")`,
  ];
}

// ── Schema fingerprint gate ──────────────────────────────────────────────────
//
// With `autoCreateTable`, `doInit` used to re-issue every `createTableStatements`
// (a CREATE TABLE + four CREATE INDEX) on the first use of each fresh store —
// harmless (`IF NOT EXISTS`) but five DDL round-trips of pure no-op in steady
// state, on every boot / reconnect. The gate replaces that with: maintain a
// `telescope_schema_meta` marker, read its one fingerprint row, and compare it
// against one computed purely in memory from the DDL. When they match we SKIP the
// create statements entirely; only an absent/mismatched fingerprint (fresh DB,
// column/index change, or SCHEMA_REVISION bump) pays for the DDL, then re-caches.

/**
 * Hand-bump escape hatch for schema changes the fingerprint below can't see.
 * Nothing today needs it — the `createTableStatements` array already encodes the
 * whole table + index shape — but bumping this invalidates every stored
 * fingerprint, forcing each process to re-run the (idempotent) DDL once.
 */
const SCHEMA_REVISION = 1;

/**
 * The marker table backing the fingerprint gate. One row PER owned entries table
 * (keyed by that table's name, so two telescope tables in one database never
 * clobber each other's marker) records the fingerprint of the schema the store
 * last reconciled. Deliberately NOT fingerprinted itself, so its own shape can
 * never invalidate the gate.
 */
export const SCHEMA_META_TABLE_NAME = 'telescope_schema_meta';

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the fingerprint marker table. Idempotent
 * and introspection-free, portable across sqlite / Postgres / MySQL (quoted
 * identifiers, portable types) — mirroring {@link createTableStatements}' style.
 */
function createSchemaMetaTableStatement(): string {
  return `CREATE TABLE IF NOT EXISTS "${SCHEMA_META_TABLE_NAME}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "fingerprint" VARCHAR(64) NOT NULL,
      "applied_at" BIGINT NOT NULL
    )`;
}

/**
 * Pure, in-memory sha256 of the owned table's schema. The
 * {@link createTableStatements} array IS the canonical schema definition here —
 * it encodes the table name plus every column and index — so hashing it, folded
 * with {@link SCHEMA_REVISION}, re-heals on any column/index/name change or a
 * manual revision bump and matches byte-for-byte otherwise.
 */
function computeSchemaFingerprint(tableName: string): string {
  const payload = JSON.stringify({
    revision: SCHEMA_REVISION,
    statements: createTableStatements(tableName),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * The slice of an AdonisJS Lucid `Database` (or `QueryClientContract`) this store
 * uses. Typed structurally so `@adonisjs/lucid` stays an *optional peer* dependency
 * and the store works against either the `Database` facade or a single connection /
 * transaction client.
 */
export interface LucidDatabaseLike {
  /** Start a SELECT/DELETE query builder on a table. */
  from(table: string): LucidQueryBuilderLike;
  /** Start an INSERT query builder on a table. */
  table(table: string): LucidInsertBuilderLike;
  /** Run a raw SQL statement (DDL, `MAX(sequence)` seed). */
  rawQuery(sql: string, bindings?: unknown[]): Promise<unknown>;
}

/** The structural query-builder surface the store leans on (Knex-shaped). */
export interface LucidQueryBuilderLike {
  where(column: string, value: unknown): this;
  where(column: string, operator: string, value: unknown): this;
  whereRaw(sql: string, bindings?: unknown[]): this;
  whereIn(column: string, values: readonly unknown[]): this;
  whereNotNull(column: string): this;
  orderBy(column: string, direction: 'asc' | 'desc'): this;
  groupBy(...columns: string[]): this;
  limit(value: number): this;
  offset(value: number): this;
  /** Aggregate MAX with an alias, e.g. `max('created_at as last_at')`. Chainable so it
   *  composes with `select()` in a grouped query. */
  max(expression: string): this;
  select(...columns: string[]): Promise<Record<string, unknown>[]>;
  count(column: string, alias: string): Promise<Record<string, unknown>[]>;
  delete(): Promise<number>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface LucidInsertBuilderLike {
  insert(row: Record<string, unknown>): Promise<unknown>;
}

/** Options for {@link LucidTelescopeStore} (and the `storage.lucid` factory). */
export interface LucidStoreOptions {
  /** Table name. Defaults to `telescope_entries`. */
  tableName?: string;
  /**
   * Hard cap on retained entries enforced on each {@link LucidTelescopeStore.prune}
   * by `keepLast`-style trimming when set. The store never auto-evicts on `record`
   * (that would add a query per write); prune on a schedule instead. Default unset.
   */
  maxEntries?: number;
  /**
   * Run {@link createTableStatements} on first use so the table exists without a
   * migration. Convenient for tests/scripts; production should run the migration.
   * Default `false`.
   */
  autoCreateTable?: boolean;
}

/**
 * A persistent, SQL-backed {@link TelescopeStore} on AdonisJS Lucid. Uses Lucid's
 * **async** query builder directly, so it works on every dialect Lucid supports
 * (sqlite / Postgres / MySQL) — no synchronous driver handle, no dialect lock-in.
 *
 * `content` and `tags` are stored as JSON text and round-tripped on read;
 * `created_at` is epoch-ms so ordering and age-pruning are integer comparisons.
 * `sequence` is seeded from `MAX(sequence)` on first use so it keeps climbing
 * across process restarts.
 *
 * Usually you don't construct this directly: `config/telescope.ts` selects it via
 * `storage.lucid({ ... })` and the provider builds it for you, lazily importing
 * `@adonisjs/lucid` only when the `lucid` driver is the active one.
 */
export class LucidTelescopeStore implements TelescopeStore {
  private readonly tableName: string;
  private readonly maxEntries: number | null;
  private readonly autoCreateTable: boolean;
  /** Lazily-resolved init (table creation + sequence seed), run at most once. */
  private ready: Promise<void> | null = null;
  private sequence = 0;
  /**
   * Single-flight write chain: every `record()` insert is queued behind the previous one so the
   * store holds at most ONE pooled connection at a time. A burst of watcher events can therefore
   * never exhaust the host app's connection pool (which telescope may share). Reads
   * (`get`/`list`/`prune`) are user-initiated and low-frequency, so they are intentionally NOT
   * serialized.
   */
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: LucidDatabaseLike,
    options: LucidStoreOptions = {},
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.maxEntries =
      options.maxEntries !== undefined && options.maxEntries > 0 ? options.maxEntries : null;
    this.autoCreateTable = options.autoCreateTable ?? false;
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    await this.init();
    const traceId = input.traceId !== undefined ? input.traceId : currentTraceId();
    const origin: BatchOrigin = isBatchOrigin(input.origin) ? input.origin : 'manual';
    const entry: Entry<TContent> = {
      id: randomUUID(),
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: input.content,
      tags: input.tags ?? [],
      sequence: this.sequence++,
      // Coerce to an integer: `duration_ms` is an INTEGER column, and watchers that measure with
      // `performance.now()` (redis / http-client / query / …) produce fractional milliseconds that
      // Postgres rejects outright ("invalid input syntax for type integer: 6.38…"). Round here — the
      // one sink to the column — so every watcher is safe without each having to remember to floor.
      durationMs: input.durationMs != null ? Math.round(input.durationMs) : null,
      origin,
      traceId,
      createdAt: new Date(),
    };

    const row: TelescopeColumns = {
      id: entry.id,
      type: entry.type,
      family_hash: entry.familyHash,
      content: safeJson(entry.content),
      tags: JSON.stringify(entry.tags),
      sequence: entry.sequence,
      duration_ms: entry.durationMs,
      origin: entry.origin,
      trace_id: entry.traceId,
      created_at: entry.createdAt.getTime(),
    };

    // Queue the insert behind any in-flight write (see `writeTail`): at most one telescope
    // connection is ever checked out of the pool. The entry is built eagerly above, so
    // `sequence`/`created_at` reflect event order even though the insert itself is serialized.
    const write = this.writeTail.then(() =>
      this.db.table(this.tableName).insert(row as unknown as Record<string, unknown>),
    );
    // Advance the chain regardless of this write's outcome — a single failed insert must not
    // wedge every subsequent write.
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return entry;
  }

  async get(id: string): Promise<Entry | null> {
    await this.init();
    const row = await this.db.from(this.tableName).where('id', id).first();
    return row ? hydrate(row as unknown as TelescopeColumns) : null;
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    await this.init();
    let builder = this.db.from(this.tableName);
    if (query.type !== undefined) builder = builder.where('type', query.type);
    if (query.familyHash !== undefined) builder = builder.where('family_hash', query.familyHash);
    if (query.traceId !== undefined) builder = builder.where('trace_id', query.traceId);
    if (query.traceIds !== undefined) {
      // An empty list means "no traces", not "no filter" — whereIn([]) already yields
      // zero rows, but being explicit keeps a caller's empty page from becoming a scan.
      if (query.traceIds.length === 0) return [];
      builder = builder.whereIn('trace_id', query.traceIds);
    }
    if (query.before !== undefined)
      builder = builder.where('created_at', '<', query.before.getTime());
    if (query.after !== undefined)
      builder = builder.where('created_at', '>', query.after.getTime());
    if (query.tag !== undefined) {
      // A tag is one element of the JSON array text, e.g. `["lib:billing",...]`.
      // Match the quoted token so `lib:bill` never matches `lib:billing`.
      builder = builder.whereRaw(`"tags" LIKE ? ESCAPE '\\'`, [
        `%${likeEscape(JSON.stringify(query.tag))}%`,
      ]);
    }
    if (query.search !== undefined) {
      const needle = `%${likeEscape(query.search.toLowerCase())}%`;
      builder = builder.whereRaw(
        `(LOWER("content") LIKE ? ESCAPE '\\' OR LOWER("tags") LIKE ? ESCAPE '\\')`,
        [needle, needle],
      );
    }
    // Newest-first: created_at desc, sequence desc as a deterministic tiebreaker.
    builder = builder.orderBy('created_at', 'desc').orderBy('sequence', 'desc');
    if (query.limit !== undefined) builder = builder.limit(query.limit);
    if (query.offset !== undefined && query.offset > 0) builder = builder.offset(query.offset);

    const rows = await builder.select('*');
    return rows.map((r) => hydrate(r as unknown as TelescopeColumns));
  }

  /**
   * The page of distinct trace ids, most-recently-seen first — the SQL fast path
   * described on {@link TelescopeStore.listTraceIds}.
   *
   * `GROUP BY trace_id` with `MAX(created_at)` lets the database do the grouping and
   * the paging, so the traces screen reads ~`limit` rows instead of every entry in
   * the window. Entries with a NULL `trace_id` are excluded: they belong to no trace
   * and would collapse into one meaningless bucket.
   */
  async listTraceIds(query: TraceIdQuery): Promise<TraceIdRow[]> {
    await this.init();
    let builder = this.db.from(this.tableName);
    if (query.before !== undefined)
      builder = builder.where('created_at', '<', query.before.getTime());
    if (query.after !== undefined)
      builder = builder.where('created_at', '>', query.after.getTime());

    // `select()` resolves the query, so it goes LAST — every chainable clause
    // (including the MAX aggregate) has to be applied before it.
    const rows = await builder
      .whereNotNull('trace_id')
      .groupBy('trace_id')
      .max('created_at as last_at')
      .orderBy('last_at', 'desc')
      .limit(query.limit)
      .offset(query.offset ?? 0)
      .select('trace_id');

    return (rows as unknown as Array<{ trace_id: string; last_at: unknown }>).map((row) => ({
      traceId: row.trace_id,
      lastAt: new Date(toInt(row.last_at)),
    }));
  }

  /**
   * Per-bucket, per-type counts for the throughput chart.
   *
   * The win here is the PROJECTION, not the grouping: the chart needs `created_at`
   * and `type` and nothing else, but the only way to get them was `list()`, which
   * does `select('*')` — shipping every row's `content` JSON blob out of the database
   * and running it through `hydrate()`, to then discard all of it except a timestamp
   * and a string. Two scalar columns instead of a blob is orders of magnitude less
   * bytes on the wire and no per-row JSON parse.
   *
   * The bucketing itself stays in JS, deliberately. Doing it in SQL needs a raw
   * select expression (`(created_at - ?) / ?`), and Lucid exposes `groupByRaw` but no
   * `selectRaw` — the alternative is `rawQuery`, whose result shape differs per driver
   * (`{ rows }` on Postgres, an array on SQLite). Trading a portability bug for the
   * second-order win is a bad deal; the row count is what would justify it, and after
   * the redis-watcher filter that count drops by roughly an order of magnitude. If
   * this is still hot with a clean table, THAT is when it earns the raw query.
   */
  async countByBucket(query: BucketCountQuery): Promise<BucketCountRow[]> {
    await this.init();
    const startMs = query.after.getTime();
    const bucketMs = Math.max(1, Math.floor(query.bucketMs));

    let builder = this.db
      .from(this.tableName)
      .where('created_at', '>', startMs)
      .where('created_at', '<=', query.before.getTime());
    if (query.type !== undefined) builder = builder.where('type', query.type);

    const rows = (await builder.select('created_at', 'type')) as unknown as Array<{
      created_at: unknown;
      type: string;
    }>;

    const tally = new Map<string, BucketCountRow>();
    for (const row of rows) {
      const index = Math.floor((toInt(row.created_at) - startMs) / bucketMs);
      const key = `${index}\u0000${row.type}`;
      const seen = tally.get(key);
      if (seen === undefined) {
        tally.set(key, { index, type: row.type, count: 1 });
      } else {
        seen.count += 1;
      }
    }
    return [...tally.values()];
  }

  async count(): Promise<number> {
    await this.init();
    const rows = await this.db.from(this.tableName).count('*', 'total');
    return toInt(rows[0]?.total);
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    await this.init();
    const cutoff = olderThan.getTime();
    if (keepLast === undefined) {
      return this.db.from(this.tableName).where('created_at', '<', cutoff).delete();
    }
    // Keep the newest `keepLast` of the doomed (older-than-cutoff) entries: find
    // their ids ordered newest-first, skip the first `keepLast`, delete the rest.
    const doomed = await this.db
      .from(this.tableName)
      .where('created_at', '<', cutoff)
      .orderBy('created_at', 'desc')
      .orderBy('sequence', 'desc')
      .select('id');
    const toDelete = doomed.slice(keepLast).map((r) => String(r.id));
    if (toDelete.length === 0) return 0;
    return this.db
      .from(this.tableName)
      .whereRaw(`"id" IN (${toDelete.map(() => '?').join(', ')})`, toDelete)
      .delete();
  }

  async clear(): Promise<void> {
    await this.init();
    await this.db.from(this.tableName).whereRaw('1 = 1').delete();
  }

  /** Cap enforcement helper for callers running a scheduled trim. */
  get capacity(): number | null {
    return this.maxEntries;
  }

  /** Run table creation (optional) + sequence seeding exactly once. */
  private init(): Promise<void> {
    if (!this.ready) this.ready = this.doInit();
    return this.ready;
  }

  private async doInit(): Promise<void> {
    if (this.autoCreateTable) {
      await this.reconcileSchema();
    }
    // Seed the in-process counter from the persisted maximum so sequence keeps
    // climbing monotonically across restarts.
    const maxRow = await this.db
      .from(this.tableName)
      .orderBy('sequence', 'desc')
      .limit(1)
      .select('sequence');
    const max = maxRow.length > 0 ? toInt(maxRow[0]?.sequence) : -1;
    this.sequence = max + 1;
  }

  /**
   * Fingerprint-gated table creation. Maintains the {@link SCHEMA_META_TABLE_NAME}
   * marker, compares the stored fingerprint against one computed in memory from
   * the DDL, and SKIPS re-issuing the (five-statement) CREATE TABLE + index DDL
   * when they match. Only an absent/mismatched fingerprint (fresh DB, column/index
   * change, or a {@link SCHEMA_REVISION} bump) runs the DDL, then re-caches.
   */
  private async reconcileSchema(): Promise<void> {
    // (1) Idempotent, introspection-free marker table.
    await this.db.rawQuery(createSchemaMetaTableStatement());
    // (2) Read the stored fingerprint + (3) compute the expected one in memory.
    const stored = await this.readStoredFingerprint();
    const expected = computeSchemaFingerprint(this.tableName);
    // (4) Steady state: identical fingerprint ⇒ skip the entries-table DDL.
    if (stored === expected) return;
    // (5) Absent/mismatch ⇒ (re)create the table + indexes, then re-cache.
    for (const stmt of createTableStatements(this.tableName)) {
      await this.db.rawQuery(stmt);
    }
    await this.writeStoredFingerprint(expected);
  }

  /** Reads this table's stored fingerprint, or null when the marker row is absent. */
  private async readStoredFingerprint(): Promise<string | null> {
    const row = await this.db.from(SCHEMA_META_TABLE_NAME).where('id', this.tableName).first();
    return row && typeof row.fingerprint === 'string' ? row.fingerprint : null;
  }

  /** Upserts this table's marker row (delete + insert, portable across dialects). */
  private async writeStoredFingerprint(fingerprint: string): Promise<void> {
    await this.db.from(SCHEMA_META_TABLE_NAME).where('id', this.tableName).delete();
    await this.db.table(SCHEMA_META_TABLE_NAME).insert({
      id: this.tableName,
      fingerprint,
      applied_at: Date.now(),
    });
  }
}

/** Options for {@link createTelescopeTable}. */
export interface CreateTableOptions {
  /** Table to create. Defaults to `telescope_entries`. */
  tableName?: string;
}

/**
 * Stand up the telescope entries table (and its indexes) through Lucid's async
 * query runner, idempotently (`CREATE TABLE IF NOT EXISTS`). Works on every Lucid
 * dialect. Handy for tests, scripts and quick-starts where running a full
 * migration is overkill.
 *
 * Production apps should prefer the bundled migration stub so the schema is
 * versioned and runs through `node ace migration:run`.
 */
export async function createTelescopeTable(
  db: LucidDatabaseLike,
  options: CreateTableOptions = {},
): Promise<void> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  for (const stmt of createTableStatements(tableName)) {
    await db.rawQuery(stmt);
  }
}

/** Parse JSON text columns back into an {@link Entry}. */
function hydrate(row: TelescopeColumns): Entry {
  return {
    id: row.id,
    type: row.type,
    familyHash: row.family_hash ?? null,
    content: parseJson(row.content),
    tags: parseTags(row.tags),
    sequence: toInt(row.sequence),
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : toInt(row.duration_ms),
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    traceId: row.trace_id ?? null,
    createdAt: new Date(toInt(row.created_at)),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseTags(text: string): string[] {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

/** Escape LIKE wildcards so user input matches literally (escape char `\`). */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
