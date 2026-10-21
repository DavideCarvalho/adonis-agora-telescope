import { createHash } from 'node:crypto';
import { access, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Entry } from '../entry.js';
import type { BucketCountQuery, BucketCountRow, EntryQuery, TraceIdRow } from '../store.js';
import type { ColdEngineContext, ColdFile, ColdReadEngine } from './parquet.js';
import { fromParquetRow, toNumber } from './parquet_format.js';
import { ensureDir, importOptionalPeer, isNotFound } from './parquet_location.js';

type DuckDBModule = typeof import('@duckdb/node-api');
type DuckDBInstance = import('@duckdb/node-api').DuckDBInstance;

/** Options for the DuckDB cold engine (`engine: { duckdb: { ... } }`). */
export interface DuckDbEngineOptions {
  /** DuckDB `memory_limit`, e.g. `'512MB'`. Default: DuckDB's own (80% of RAM). */
  memoryLimit?: string;
  /** DuckDB worker threads. Default 2, so a wide scan cannot take every core. */
  threads?: number;
  /**
   * Where remote (S3) files are copied before DuckDB reads them, since DuckDB only reads
   * them by path here. Default `<os tmpdir>/adonis-telescope-parquet`.
   */
  cacheDir?: string;
  /** Bytes of copied files kept in {@link cacheDir}. Default 1 GiB. */
  cacheBytes?: number;
}

/**
 * The optional DuckDB cold engine (`@duckdb/node-api`, an optional peer).
 *
 * It only reads files by local path. A directory location's files are read in place;
 * remote files are fetched through the location (the host's own S3 client) into a
 * bounded local cache first. The instance is locked down at start: extension
 * auto-install/auto-load off, external access off except the data and cache
 * directories, and the configuration locked, so DuckDB can never download or load
 * `httpfs` / `aws` (they are not bundled; DuckDB would fetch them at runtime).
 */
export class DuckDbEngine implements ColdReadEngine {
  readonly name = 'duckdb' as const;
  private readonly cache: LocalFileCache | null;

  private constructor(
    private readonly ctx: ColdEngineContext,
    private readonly instance: DuckDBInstance,
    cache: LocalFileCache | null,
  ) {
    this.cache = cache;
  }

  /** Build the engine. Fails with a clear error when `@duckdb/node-api` is missing. */
  static async create(
    ctx: ColdEngineContext,
    options: DuckDbEngineOptions = {},
  ): Promise<DuckDbEngine> {
    const duckdb = await loadDuckDb();
    const localRoot = ctx.location.localRoot;
    const cache =
      localRoot === undefined
        ? new LocalFileCache(
            ctx,
            resolve(options.cacheDir ?? join(tmpdir(), 'adonis-telescope-parquet')),
            options.cacheBytes ?? 1024 ** 3,
          )
        : null;
    if (cache) await cache.init();
    const dataDir = localRoot ?? cache!.dir;

    const instance = await duckdb.DuckDBInstance.create(':memory:', {
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_community_extensions: 'false',
      threads: String(Math.max(1, Math.floor(options.threads ?? 2))),
      ...(options.memoryLimit !== undefined ? { memory_limit: options.memoryLimit } : {}),
    });
    const connection = await instance.connect();
    try {
      // Checked before the lockdown: listing extensions reads DuckDB's extension directory.
      const loaded = await connection.runAndReadAll(
        "SELECT extension_name FROM duckdb_extensions() WHERE loaded AND extension_name IN ('httpfs', 'aws')",
      );
      if (loaded.getRowObjectsJson().length > 0) {
        throw new Error(
          '@adonis-agora/telescope: DuckDB started with httpfs/aws loaded; refusing to use it.',
        );
      }
      await connection.run(`SET allowed_directories = [${literal(withSlash(resolve(dataDir)))}]`);
      await connection.run('SET enable_external_access = false');
      await connection.run('SET lock_configuration = true');
    } finally {
      connection.closeSync();
    }
    return new DuckDbEngine(ctx, instance, cache);
  }

  async list(files: ColdFile[], query: EntryQuery, limit: number | undefined): Promise<Entry[]> {
    if (files.length === 0) return [];
    const where = new Where();
    if (query.type !== undefined) where.add('type = ?', query.type);
    if (query.familyHash !== undefined) where.add('family_hash = ?', query.familyHash);
    if (query.traceId !== undefined) where.add('trace_id = ?', query.traceId);
    if (query.traceIds !== undefined) {
      if (query.traceIds.length === 0) return [];
      where.add(`trace_id IN (${query.traceIds.map(() => '?').join(', ')})`, ...query.traceIds);
    }
    if (query.before !== undefined)
      where.add('created_at < epoch_ms(?::BIGINT)', query.before.getTime());
    if (query.after !== undefined)
      where.add('created_at > epoch_ms(?::BIGINT)', query.after.getTime());
    if (query.tag !== undefined) where.add('contains(tags, ?)', JSON.stringify(query.tag));
    if (query.search !== undefined) {
      const needle = query.search.toLowerCase();
      where.add('(contains(lower(content), ?) OR contains(lower(tags), ?))', needle, needle);
    }
    const rows = await this.query(
      files,
      (source) =>
        `SELECT ${ENTRY_COLUMNS} FROM ${source}${where.sql()} ORDER BY created_at_ms DESC, sequence DESC, id DESC${
          limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ''
        }`,
      where.values,
    );
    return rows.map(toEntry);
  }

  async get(files: ColdFile[], id: string): Promise<Entry | null> {
    if (files.length === 0) return null;
    const rows = await this.query(
      files,
      (source) => `SELECT ${ENTRY_COLUMNS} FROM ${source} WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows.length === 0 ? null : toEntry(rows[0]!);
  }

  async traceIds(
    files: ColdFile[],
    query: { before?: Date; after?: Date },
    limit: number,
  ): Promise<TraceIdRow[]> {
    if (files.length === 0) return [];
    const where = new Where();
    where.add('trace_id IS NOT NULL');
    if (query.before !== undefined)
      where.add('created_at < epoch_ms(?::BIGINT)', query.before.getTime());
    if (query.after !== undefined)
      where.add('created_at > epoch_ms(?::BIGINT)', query.after.getTime());
    const rows = await this.query(
      files,
      (source) =>
        `SELECT trace_id, max(epoch_ms(created_at)) AS last_at FROM ${source}${where.sql()} GROUP BY trace_id ORDER BY last_at DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
      where.values,
    );
    return rows.map((row) => ({
      traceId: String(row.trace_id),
      lastAt: new Date(toNumber(row.last_at)),
    }));
  }

  async countByBucket(files: ColdFile[], query: BucketCountQuery): Promise<BucketCountRow[]> {
    if (files.length === 0) return [];
    const startMs = query.after.getTime();
    const bucketMs = Math.max(1, Math.floor(query.bucketMs));
    const where = new Where();
    where.add('created_at > epoch_ms(?::BIGINT)', startMs);
    where.add('created_at <= epoch_ms(?::BIGINT)', query.before.getTime());
    if (query.type !== undefined) where.add('type = ?', query.type);
    const rows = await this.query(
      files,
      (source) =>
        `SELECT CAST(floor((epoch_ms(created_at) - ${startMs}) / ${bucketMs}) AS BIGINT) AS idx, type, count(*) AS n FROM ${source}${where.sql()} GROUP BY 1, 2`,
      where.values,
    );
    return rows.map((row) => ({
      index: toNumber(row.idx),
      type: String(row.type),
      count: toNumber(row.n),
    }));
  }

  async close(): Promise<void> {
    this.instance.closeSync();
  }

  /**
   * Run one statement over `files`. A file deleted between listing and reading
   * (retention, compaction) makes DuckDB fail the whole scan, so on an IO error the
   * statement is retried once over the files that still exist.
   */
  private async query(
    files: ColdFile[],
    sql: (source: string) => string,
    values: Array<string | number>,
  ): Promise<Record<string, unknown>[]> {
    let paths = await this.paths(files);
    for (let attempt = 0; ; attempt++) {
      if (paths.length === 0) return [];
      const connection = await this.instance.connect();
      try {
        const reader = await connection.runAndReadAll(sql(source(paths)), values);
        return reader.getRowObjectsJS() as Record<string, unknown>[];
      } catch (error: unknown) {
        if (attempt > 0 || !/IO Error|No files found/i.test(String((error as Error)?.message)))
          throw error;
        paths = await existing(paths);
      } finally {
        connection.closeSync();
      }
    }
  }

  private async paths(files: ColdFile[]): Promise<string[]> {
    if (this.cache === null) {
      const local = this.ctx.location.localPath!;
      return files.map((file) => local.call(this.ctx.location, file.key));
    }
    const out: string[] = [];
    for (const file of files) {
      const path = await this.cache.ensure(file);
      if (path !== null) out.push(path);
    }
    return out;
  }
}

const ENTRY_COLUMNS =
  'id, type, family_hash, content, tags, sequence, duration_ms, origin, trace_id, epoch_ms(created_at) AS created_at_ms';

function toEntry(row: Record<string, unknown>): Entry {
  return fromParquetRow({ ...row, created_at: toNumber(row.created_at_ms) });
}

function source(paths: string[]): string {
  return `read_parquet([${paths.map(literal).join(', ')}])`;
}

class Where {
  private readonly clauses: string[] = [];
  readonly values: Array<string | number> = [];

  add(clause: string, ...values: Array<string | number>): void {
    this.clauses.push(clause);
    this.values.push(...values);
  }

  sql(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.join(' AND ')}`;
  }
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function withSlash(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

async function existing(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    try {
      await access(path);
      out.push(path);
    } catch {
      // gone
    }
  }
  return out;
}

async function loadDuckDb(): Promise<DuckDBModule> {
  return importOptionalPeer(
    '@duckdb/node-api',
    "storage.parquet({ engine: 'duckdb' })",
    () => import('@duckdb/node-api'),
  );
}

/**
 * Remote files copied to local disk for DuckDB, keyed by a hash of their (immutable)
 * key and evicted least-recently-used past a byte budget. Copies go through the
 * location, i.e. the host's own S3 client.
 */
class LocalFileCache {
  private readonly entries = new Map<string, { path: string; size: number }>();
  private bytes = 0;

  constructor(
    private readonly ctx: ColdEngineContext,
    readonly dir: string,
    private readonly budget: number,
  ) {}

  async init(): Promise<void> {
    await ensureDir(this.dir);
  }

  async ensure(file: ColdFile): Promise<string | null> {
    const hit = this.entries.get(file.key);
    if (hit) {
      this.entries.delete(file.key);
      this.entries.set(file.key, hit);
      return hit.path;
    }
    const path = join(this.dir, `${createHash('sha256').update(file.key).digest('hex')}.parquet`);
    try {
      await stat(path);
    } catch {
      let bytes: Uint8Array;
      try {
        bytes = await this.ctx.location.read(file.key, 0);
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, path);
    }
    this.entries.set(file.key, { path, size: file.size });
    this.bytes += file.size;
    await this.evict();
    return path;
  }

  private async evict(): Promise<void> {
    while (this.bytes > this.budget && this.entries.size > 1) {
      const [key, oldest] = this.entries.entries().next().value as [
        string,
        { path: string; size: number },
      ];
      this.entries.delete(key);
      this.bytes -= oldest.size;
      await rm(oldest.path, { force: true });
    }
  }
}
