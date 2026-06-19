import { randomUUID } from 'node:crypto';
import {
  type BatchOrigin,
  type Entry,
  type EntryQuery,
  type RecordInput,
  type TelescopeStore,
  currentTraceId,
  isBatchOrigin,
} from '@agora/telescope';
import { DEFAULT_TABLE_NAME, type TelescopeColumns, createTableStatements } from './schema.js';

/**
 * The slice of an AdonisJS Lucid `Database` (or `QueryClientContract`) this store
 * uses. Typed structurally so the package's `@adonisjs/lucid` stays a *peer*
 * dependency and the store works against either the `Database` facade or a single
 * connection / transaction client.
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
  orderBy(column: string, direction: 'asc' | 'desc'): this;
  limit(value: number): this;
  select(...columns: string[]): Promise<Record<string, unknown>[]>;
  count(column: string, alias: string): Promise<Record<string, unknown>[]>;
  delete(): Promise<number>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface LucidInsertBuilderLike {
  insert(row: Record<string, unknown>): Promise<unknown>;
}

/** Options for {@link LucidTelescopeStore}. */
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
 */
export class LucidTelescopeStore implements TelescopeStore {
  private readonly tableName: string;
  private readonly maxEntries: number | null;
  private readonly autoCreateTable: boolean;
  /** Lazily-resolved init (table creation + sequence seed), run at most once. */
  private ready: Promise<void> | null = null;
  private sequence = 0;

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
      durationMs: input.durationMs ?? null,
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
    await this.db.table(this.tableName).insert(row as unknown as Record<string, unknown>);
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

    const rows = await builder.select('*');
    return rows.map((r) => hydrate(r as unknown as TelescopeColumns));
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
      for (const stmt of createTableStatements(this.tableName)) {
        await this.db.rawQuery(stmt);
      }
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
