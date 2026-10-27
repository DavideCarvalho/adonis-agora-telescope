import { createHash, randomUUID } from 'node:crypto';
import { currentTraceId } from '../context_accessor.js';
import { type BatchOrigin, type Entry, isBatchOrigin, type RecordInput } from '../entry.js';
import { resolveOrigin } from '../origin_scope.js';
import { runAsTelescopeWork } from '../self_scope.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  FamilyCountQuery,
  KeyCountRow,
  TagCountQuery,
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
 * Identifiers are double-quoted (sqlite / Postgres) unless `dialect` is a Lucid
 * MySQL dialect name (`mysql` / `mysql2`), which gets backticks and plain
 * `CREATE INDEX`; the column types are portable. A real deployment should still prefer the bundled migration stub
 * so the schema is versioned, but this lets a store stand itself up in tests and
 * scripts without a migration runner.
 */
export function createTableStatements(
  tableName: string = DEFAULT_TABLE_NAME,
  dialect?: string,
): string[] {
  const mysql = isMysql(dialect);
  const q = (identifier: string) => (mysql ? `\`${identifier}\`` : `"${identifier}"`);
  // MySQL has no `CREATE INDEX IF NOT EXISTS`; an index that already exists fails with
  // ER_DUP_KEYNAME, which the store's reconcile treats as done.
  const index = (suffix: string, columns: string[]) =>
    `CREATE INDEX ${mysql ? '' : 'IF NOT EXISTS '}${q(`${tableName}_${suffix}`)} ON ${q(tableName)} (${columns.map(q).join(', ')})`;
  return [
    `CREATE TABLE IF NOT EXISTS ${q(tableName)} (
      ${q('id')} VARCHAR(255) PRIMARY KEY NOT NULL,
      ${q('type')} VARCHAR(255) NOT NULL,
      ${q('family_hash')} VARCHAR(255) NULL,
      ${q('content')} TEXT NOT NULL,
      ${q('tags')} TEXT NOT NULL,
      ${q('sequence')} INTEGER NOT NULL,
      ${q('duration_ms')} INTEGER NULL,
      ${q('origin')} VARCHAR(255) NOT NULL,
      ${q('trace_id')} VARCHAR(255) NULL,
      ${q('created_at')} BIGINT NOT NULL
    )`,
    index('created_at_idx', ['created_at']),
    index('trace_id_idx', ['trace_id']),
    // The dashboard's per-type reads are `WHERE type = ? AND created_at > ? ORDER BY
    // created_at DESC, sequence DESC LIMIT n`: this one index answers them in order.
    index('type_created_at_sequence_idx', ['type', 'created_at', 'sequence']),
    index('family_hash_created_at_idx', ['family_hash', 'created_at']),
  ];
}

/** MySQL (and MariaDB) quote identifiers with backticks; a double-quoted name is a string there. */
function isMysql(dialect: string | undefined): boolean {
  return dialect === 'mysql' || dialect === 'mysql2';
}

/** The Lucid dialect name of `db`, from the client itself or the facade's default connection. */
function dialectOf(db: LucidDatabaseLike): string | undefined {
  return db.dialect?.name ?? db.connection?.().dialect?.name;
}

/** Whether `error` is MySQL's "index already exists". */
function isDuplicateIndex(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return code === 'ER_DUP_KEYNAME' || errno === 1061;
}

/** Run the DDL for `tableName` on `db`, in its dialect. */
async function runTableStatements(db: LucidDatabaseLike, tableName: string): Promise<void> {
  const dialect = dialectOf(db);
  for (const stmt of createTableStatements(tableName, dialect)) {
    try {
      await db.rawQuery(stmt);
    } catch (error) {
      if (!(isMysql(dialect) && isDuplicateIndex(error))) throw error;
    }
  }
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
function createSchemaMetaTableStatement(dialect?: string): string {
  const q = (identifier: string) => (isMysql(dialect) ? `\`${identifier}\`` : `"${identifier}"`);
  return `CREATE TABLE IF NOT EXISTS ${q(SCHEMA_META_TABLE_NAME)} (
      ${q('id')} VARCHAR(255) PRIMARY KEY NOT NULL,
      ${q('fingerprint')} VARCHAR(64) NOT NULL,
      ${q('applied_at')} BIGINT NOT NULL
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
  /** The dialect, when this is a single connection client. Picks the DDL's identifier quoting. */
  dialect?: { name: string };
  /** The default connection, when this is the `Database` facade. */
  connection?(): { dialect?: { name: string } };
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
  /** Group by an expression. Optional: without it, `countByBucket` buckets rows in JS. */
  groupByRaw?(sql: string, bindings?: unknown[]): this;
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
  /** Insert one row, or several in one statement. */
  insert(row: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown>;
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

/** Rows per multi-row INSERT. Ten columns each keeps a statement at 900 bound values,
 *  under the smallest limit of any dialect Lucid drives (999 on older SQLite builds). */
const INSERT_BATCH_ROWS = 90;
/** Serialized bytes per INSERT, so a batch of large entries stays far below MySQL's
 *  default `max_allowed_packet`. A single entry over it is still written, alone. */
const INSERT_BATCH_BYTES = 4 * 1024 * 1024;
/** Entries waiting to be written. Past this, new entries are dropped and counted
 *  rather than queued: a database that stopped keeping up must not grow the heap. */
const MAX_PENDING_WRITES = 10_000;
/** Rows deleted per statement while pruning. */
const PRUNE_BATCH_ROWS = 5_000;
/** Rows read per page while counting tags. */
const TAG_SCAN_PAGE_ROWS = 5_000;
/** Every column but `content`, for reads that set {@link EntryQuery.omitContent}. */
const COLUMNS_WITHOUT_CONTENT = [
  'id',
  'type',
  'family_hash',
  'tags',
  'sequence',
  'duration_ms',
  'origin',
  'trace_id',
  'created_at',
];

/** One entry waiting in {@link LucidTelescopeStore}'s write buffer. */
interface PendingWrite {
  row: TelescopeColumns;
  bytes: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A row's position in newest-first order. */
interface RowPosition {
  createdAt: number;
  sequence: number;
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
 * Writes are buffered: every entry recorded during one tick of the event loop goes
 * out in one multi-row INSERT (split to stay under each dialect's bind limit), one
 * statement at a time, so the store never holds more than one pooled connection
 * for writing and a burst of watcher events costs a handful of round trips instead
 * of one each. `record()` still resolves once its entry is persisted.
 *
 * Every query the store runs is marked as telescope's own work (see
 * `self_scope.ts`), so the query watcher never records them.
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
  private pending: PendingWrite[] = [];
  /** The running drain, while one is scheduled or writing. */
  private draining: Promise<void> | null = null;
  private dropped = 0;
  private warnedDrop = false;

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
    const origin: BatchOrigin = resolveOrigin(input.origin);
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

    if (this.pending.length >= MAX_PENDING_WRITES) {
      this.dropped += 1;
      if (!this.warnedDrop) {
        this.warnedDrop = true;
        console.warn(
          `@adonis-agora/telescope: ${MAX_PENDING_WRITES} entries are waiting to be written to ` +
            `"${this.tableName}"; new entries are dropped until the database catches up.`,
        );
      }
      return entry;
    }

    await new Promise<void>((resolve, reject) => {
      this.pending.push({
        row,
        bytes: row.content.length + row.tags.length,
        resolve,
        reject,
      });
      this.scheduleDrain();
    });
    return entry;
  }

  /** Entries dropped because the write buffer was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Resolves once every entry recorded so far has been written (or has failed). */
  async flush(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  get(id: string): Promise<Entry | null> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const row = await this.db.from(this.tableName).where('id', id).first();
      return row ? hydrate(row as unknown as TelescopeColumns) : null;
    });
  }

  list(query: EntryQuery = {}): Promise<Entry[]> {
    return runAsTelescopeWork(async () => {
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
        builder = builder.whereRaw(`?? LIKE ? ESCAPE '!'`, [
          'tags',
          `%${likeEscape(JSON.stringify(query.tag))}%`,
        ]);
      }
      if (query.search !== undefined) {
        const needle = `%${likeEscape(query.search.toLowerCase())}%`;
        builder = builder.whereRaw(`(LOWER(??) LIKE ? ESCAPE '!' OR LOWER(??) LIKE ? ESCAPE '!')`, [
          'content',
          needle,
          'tags',
          needle,
        ]);
      }
      // Newest-first: created_at desc, sequence desc as a deterministic tiebreaker.
      builder = builder.orderBy('created_at', 'desc').orderBy('sequence', 'desc');
      // `{ page, size }` in, `LIMIT/OFFSET` out: the 1-based page becomes `(page - 1) * size`.
      if (query.size !== undefined && query.size > 0) {
        const size = Math.floor(query.size);
        const page = Math.max(1, Math.floor(query.page ?? 1));
        builder = builder.limit(size);
        if (page > 1) builder = builder.offset((page - 1) * size);
      }

      const rows = await (query.omitContent === true
        ? builder.select(...COLUMNS_WITHOUT_CONTENT)
        : builder.select('*'));
      return rows.map((r) => hydrate(r as unknown as TelescopeColumns));
    });
  }

  /**
   * The page of distinct trace ids, most-recently-seen first — the SQL fast path
   * described on {@link TelescopeStore.listTraceIds}.
   *
   * `GROUP BY trace_id` with `MAX(created_at)` lets the database do the grouping and
   * the paging, so the traces screen reads ~`size` rows instead of every entry in
   * the window. Entries with a NULL `trace_id` are excluded: they belong to no trace
   * and would collapse into one meaningless bucket.
   */
  listTraceIds(query: TraceIdQuery): Promise<TraceIdRow[]> {
    return runAsTelescopeWork(async () => {
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
        .limit(query.size)
        .offset(
          (Math.max(1, Math.floor(query.page ?? 1)) - 1) * Math.max(0, Math.floor(query.size)),
        )
        .select('trace_id');

      return (rows as unknown as Array<{ trace_id: string; last_at: unknown }>).map((row) => ({
        traceId: row.trace_id,
        lastAt: new Date(toInt(row.last_at)),
      }));
    });
  }

  /**
   * Per-bucket, per-type counts for the throughput chart, grouped in SQL so one row
   * per `(bucket, type)` leaves the database instead of one per entry.
   *
   * The bucket is `(created_at - start) - ((created_at - start) % bucketMs)`: integer
   * arithmetic every dialect evaluates the same way, where `/` would be integer
   * division on some and decimal on MySQL. Each group reports its newest
   * `created_at`, and the bucket index is computed from that in JS. A builder
   * without `groupByRaw` gets the per-row projection, bucketed here.
   */
  countByBucket(query: BucketCountQuery): Promise<BucketCountRow[]> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const startMs = query.after.getTime();
      const bucketMs = Math.max(1, Math.floor(query.bucketMs));

      let builder = this.db
        .from(this.tableName)
        .where('created_at', '>', startMs)
        .where('created_at', '<=', query.before.getTime());
      if (query.type !== undefined) builder = builder.where('type', query.type);

      const tally = new Map<string, BucketCountRow>();
      const add = (createdAt: unknown, type: string, count: number) => {
        const index = Math.floor((toInt(createdAt) - startMs) / bucketMs);
        const key = `${index}\u0000${type}`;
        const seen = tally.get(key);
        if (seen === undefined) tally.set(key, { index, type, count });
        else seen.count += count;
      };

      if (typeof builder.groupByRaw === 'function') {
        // `type` is a GROUP BY column; MAX() is how this builder surface selects it
        // next to the aggregates. Aliased apart from the column so MySQL, which
        // resolves GROUP BY names to select aliases first, still groups by the column.
        const rows = (await builder
          .groupByRaw('(?? - ?) - ((?? - ?) % ?)', [
            'created_at',
            startMs,
            'created_at',
            startMs,
            bucketMs,
          ])
          .groupBy('type')
          .max('type as entry_type')
          .max('created_at as last_at')
          .count('*', 'total')) as unknown as Array<{
          entry_type: string;
          last_at: unknown;
          total: unknown;
        }>;
        for (const row of rows) add(row.last_at, row.entry_type, toInt(row.total));
      } else {
        const rows = (await builder.select('created_at', 'type')) as unknown as Array<{
          created_at: unknown;
          type: string;
        }>;
        for (const row of rows) add(row.created_at, row.type, 1);
      }
      return [...tally.values()];
    });
  }

  /**
   * The busiest families, counted by `GROUP BY family_hash` — see
   * {@link TelescopeStore.countFamilies}.
   */
  countFamilies(query: FamilyCountQuery): Promise<KeyCountRow[]> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const limit = Math.max(0, Math.floor(query.limit));
      if (limit === 0) return [];
      let builder = this.db
        .from(this.tableName)
        .whereNotNull('family_hash')
        .where('family_hash', '<>', '');
      if (query.type !== undefined) builder = builder.where('type', query.type);
      // `family_hash` is the GROUP BY column; MAX() selects it next to the aggregates
      // (see countByBucket for the alias).
      const rows = (await builder
        .groupBy('family_hash')
        .max('family_hash as family_key')
        .max('created_at as last_at')
        .max('sequence as last_sequence')
        .orderBy('total', 'desc')
        .orderBy('last_at', 'desc')
        .orderBy('last_sequence', 'desc')
        .limit(limit)
        .count('*', 'total')) as unknown as Array<{ family_key: string; total: unknown }>;
      return rows.map((row) => ({ key: row.family_key, count: toInt(row.total) }));
    });
  }

  /**
   * The most common tags — see {@link TelescopeStore.countTags}. Tags are JSON text,
   * so they are counted here, reading only the `tags` column a page at a time in
   * primary-key order.
   */
  countTags(query: TagCountQuery): Promise<KeyCountRow[]> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const limit = Math.max(0, Math.floor(query.limit));
      if (limit === 0) return [];
      const tally = new Map<string, { count: number; newest: RowPosition }>();
      let afterId: string | null = null;
      for (;;) {
        let builder = this.db.from(this.tableName);
        if (afterId !== null) builder = builder.where('id', '>', afterId);
        const rows = (await builder
          .orderBy('id', 'asc')
          .limit(TAG_SCAN_PAGE_ROWS)
          .select('id', 'tags', 'created_at', 'sequence')) as unknown as Array<{
          id: unknown;
          tags: string;
          created_at: unknown;
          sequence: unknown;
        }>;
        for (const row of rows) {
          const position = { createdAt: toInt(row.created_at), sequence: toInt(row.sequence) };
          for (const tag of parseTags(row.tags)) {
            if (query.prefix !== undefined && !tag.startsWith(query.prefix)) continue;
            const seen = tally.get(tag);
            if (seen === undefined) {
              tally.set(tag, { count: 1, newest: position });
            } else {
              seen.count += 1;
              if (isNewer(position, seen.newest)) seen.newest = position;
            }
          }
        }
        if (rows.length < TAG_SCAN_PAGE_ROWS) break;
        afterId = String(rows[rows.length - 1]!.id);
      }
      return [...tally.entries()]
        .sort(([, a], [, b]) => b.count - a.count || (isNewer(a.newest, b.newest) ? -1 : 1))
        .slice(0, limit)
        .map(([key, { count }]) => ({ key, count }));
    });
  }

  count(): Promise<number> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const rows = await this.db.from(this.tableName).count('*', 'total');
      return toInt(rows[0]?.total);
    });
  }

  /**
   * Deletes oldest-first, {@link PRUNE_BATCH_ROWS} rows per statement, each batch
   * addressed by its newest row's position rather than by id: a backlog of any size
   * is pruned in bounded statements that never approach a bind limit.
   */
  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return runAsTelescopeWork(async () => {
      await this.init();
      const cutoff = olderThan.getTime();
      // With `keepLast`, the doomed rows end at the first one past the newest
      // `keepLast` of those older than the cutoff.
      let newestDoomed: RowPosition | null = null;
      if (keepLast !== undefined) {
        newestDoomed = await this.position(
          this.db
            .from(this.tableName)
            .where('created_at', '<', cutoff)
            .orderBy('created_at', 'desc')
            .orderBy('sequence', 'desc')
            .offset(Math.max(0, Math.floor(keepLast))),
        );
        if (newestDoomed === null) return 0;
      }
      const doomed = (): LucidQueryBuilderLike => {
        const builder = this.db.from(this.tableName);
        return newestDoomed === null
          ? builder.where('created_at', '<', cutoff)
          : atOrBefore(builder, newestDoomed);
      };

      let deleted = 0;
      for (;;) {
        const batchEdge = await this.position(
          doomed()
            .orderBy('created_at', 'asc')
            .orderBy('sequence', 'asc')
            .offset(PRUNE_BATCH_ROWS - 1),
        );
        if (batchEdge === null) return deleted + toInt(await doomed().delete());
        deleted += toInt(await atOrBefore(doomed(), batchEdge).delete());
      }
    });
  }

  clear(): Promise<void> {
    return runAsTelescopeWork(async () => {
      await this.init();
      await this.flush();
      await this.db.from(this.tableName).whereRaw('1 = 1').delete();
    });
  }

  /** Cap enforcement helper for callers running a scheduled trim. */
  get capacity(): number | null {
    return this.maxEntries;
  }

  /** The first row of an ordered query, as a position. */
  private async position(builder: LucidQueryBuilderLike): Promise<RowPosition | null> {
    const rows = await builder.limit(1).select('created_at', 'sequence');
    const row = rows[0];
    return row === undefined
      ? null
      : { createdAt: toInt(row.created_at), sequence: toInt(row.sequence) };
  }

  /** Start a drain on the next tick unless one is already running. */
  private scheduleDrain(): void {
    if (this.draining !== null) return;
    this.draining = new Promise<void>((resolve) => {
      setImmediate(() => {
        void runAsTelescopeWork(() => this.drain()).finally(() => {
          this.draining = null;
          resolve();
          // A write can arrive between the drain emptying the buffer and this callback.
          if (this.pending.length > 0) this.scheduleDrain();
        });
      });
    });
  }

  /** Write the buffer out, batch by batch, until it is empty. */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      await this.writeBatch(this.takeBatch());
    }
    this.warnedDrop = false;
  }

  /** The oldest pending writes that fit one INSERT. */
  private takeBatch(): PendingWrite[] {
    let count = 0;
    let bytes = 0;
    for (const write of this.pending) {
      if (count === INSERT_BATCH_ROWS) break;
      if (count > 0 && bytes + write.bytes > INSERT_BATCH_BYTES) break;
      count += 1;
      bytes += write.bytes;
    }
    return this.pending.splice(0, count);
  }

  /**
   * One multi-row INSERT. When it fails, its rows are retried one at a time, so a
   * row the database rejects fails only its own `record()`.
   */
  private async writeBatch(batch: PendingWrite[]): Promise<void> {
    try {
      await this.db
        .table(this.tableName)
        .insert(batch.map((write) => write.row as unknown as Record<string, unknown>));
      for (const write of batch) write.resolve();
      return;
    } catch (error) {
      if (batch.length === 1) {
        batch[0]!.reject(error);
        return;
      }
    }
    for (const write of batch) {
      try {
        await this.db.table(this.tableName).insert(write.row as unknown as Record<string, unknown>);
        write.resolve();
      } catch (error) {
        write.reject(error);
      }
    }
  }

  /** Run table creation (optional) + sequence seeding exactly once. */
  private init(): Promise<void> {
    if (!this.ready) this.ready = runAsTelescopeWork(() => this.doInit());
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
    await this.db.rawQuery(createSchemaMetaTableStatement(dialectOf(this.db)));
    // (2) Read the stored fingerprint + (3) compute the expected one in memory.
    const stored = await this.readStoredFingerprint();
    const expected = computeSchemaFingerprint(this.tableName);
    // (4) Steady state: identical fingerprint ⇒ skip the entries-table DDL.
    if (stored === expected) return;
    // (5) Absent/mismatch ⇒ (re)create the table + indexes, then re-cache.
    await runTableStatements(this.db, this.tableName);
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
  await runTableStatements(db, options.tableName ?? DEFAULT_TABLE_NAME);
}

/** Parse JSON text columns back into an {@link Entry}. */
function hydrate(row: TelescopeColumns): Entry {
  return {
    id: row.id,
    type: row.type,
    familyHash: row.family_hash ?? null,
    content: 'content' in row ? parseJson(row.content) : null,
    tags: parseTags(row.tags),
    sequence: toInt(row.sequence),
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : toInt(row.duration_ms),
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    traceId: row.trace_id ?? null,
    createdAt: new Date(toInt(row.created_at)),
  };
}

/** Restrict `builder` to rows at or before `position` in oldest-first order. */
function atOrBefore(builder: LucidQueryBuilderLike, position: RowPosition): LucidQueryBuilderLike {
  return builder.whereRaw('(?? < ? OR (?? = ? AND ?? <= ?))', [
    'created_at',
    position.createdAt,
    'created_at',
    position.createdAt,
    'sequence',
    position.sequence,
  ]);
}

/** Whether `a` comes before `b` in newest-first order. */
function isNewer(a: RowPosition, b: RowPosition): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.sequence > b.sequence);
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

/**
 * Escape LIKE wildcards so user input matches literally. The escape character is `!`
 * rather than a backslash, which MySQL would read as escaping the closing quote of
 * `ESCAPE '\'`.
 */
function likeEscape(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}
