import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Entry } from '../entry.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  TraceIdQuery,
  TraceIdRow,
} from '../store.js';
import {
  compareNewestFirst,
  HOUR_MS,
  hourStart,
  PARQUET_COLUMNS,
  type ParquetRow,
  parsePartition,
  partitionPrefix,
  resolvePage,
  toDate,
  toParquetRow,
  typePrefix,
} from './parquet_format.js';
import { type ColdObjectStore, importOptionalPeer, isNotFound } from './parquet_location.js';

type Hyparquet = typeof import('hyparquet');
type HyparquetWriter = typeof import('hyparquet-writer');
type FileMetaData = import('hyparquet').FileMetaData;
type AsyncBuffer = import('hyparquet').AsyncBuffer;
type Compressors = import('hyparquet').Compressors;

/** Row-group time bounds, read from the `created_at` column statistics. */
export interface RowGroupStats {
  rowStart: number;
  rowEnd: number;
  minMs: number;
  maxMs: number;
}

/** What the cold store knows about one file without reading its rows. */
export interface ColdFile {
  key: string;
  size: number;
  type: string;
  hourStartMs: number;
  numRows: number;
  minMs: number;
  maxMs: number;
  rowGroups: RowGroupStats[];
}

/** The libraries both engines share: hyparquet reads footers, hyparquet-writer writes. */
export interface ParquetLibs {
  hyparquet: Hyparquet;
  writer: HyparquetWriter;
  compressors: Compressors;
}

/**
 * Everything an engine needs to read files: the location, the shared libraries and
 * the footer cache. Engines never list or write; the cold store hands them the
 * candidate files already pruned by partition and statistics.
 */
export interface ColdEngineContext {
  location: ColdObjectStore;
  libs: ParquetLibs;
  /** Parsed footer of a file (cached). */
  metadata(file: ColdFile): Promise<FileMetaData>;
  /** A hyparquet `AsyncBuffer` over a file (ranged reads through the location). */
  buffer(file: ColdFile): AsyncBuffer;
}

/**
 * A cold-tier reader. `files` arrive pruned by the query's type and time bounds and
 * sorted newest-first by their newest row; every method must treat a file that has
 * vanished since it was listed (compaction, retention) as empty.
 */
export interface ColdReadEngine {
  readonly name: 'hyparquet' | 'duckdb';
  /** The newest `limit` matches (all matches when `limit` is undefined), newest-first. */
  list(files: ColdFile[], query: EntryQuery, limit: number | undefined): Promise<Entry[]>;
  get(files: ColdFile[], id: string): Promise<Entry | null>;
  /** The `limit` most-recently-seen trace ids in `files`, with their newest timestamp. */
  traceIds(
    files: ColdFile[],
    query: Pick<TraceIdQuery, 'before' | 'after'>,
    limit: number,
  ): Promise<TraceIdRow[]>;
  countByBucket(files: ColdFile[], query: BucketCountQuery): Promise<BucketCountRow[]>;
  close(): Promise<void>;
}

/** Builds a {@link ColdReadEngine} for a store. */
export type ColdEngineFactory = (
  context: ColdEngineContext,
) => ColdReadEngine | Promise<ColdReadEngine>;

/** Options for {@link ParquetColdStore}. */
export interface ParquetColdStoreOptions {
  location: ColdObjectStore;
  /** Builds the reader, bound to this store's footer cache. */
  engine: ColdEngineFactory;
  libs: ParquetLibs;
  /**
   * Written into every file name (`<instanceId>-<uuid>.parquet`) and the `instance_id`
   * column, so files from different pods never collide. Defaults to `<hostname>-<pid>`.
   */
  instanceId?: string;
  /** Rows per row group. Default 10,000. */
  rowGroupSize?: number;
  /** Rows per file before a write starts a new file. Default 200,000. */
  maxRowsPerFile?: number;
  /** How long a directory listing is reused, in ms. Default 2,000. */
  listingTtlMs?: number;
  /** Parsed footers kept in memory. Default 2,000 files. */
  metadataCacheSize?: number;
  /** Closed hours compacted per {@link ParquetColdStore.compact} call. Default 4. */
  compactPartitionsPerRun?: number;
}

/**
 * Entries as hourly-partitioned Parquet files in a {@link ColdObjectStore}:
 *
 * ```
 * type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet
 * ```
 *
 * Files are append-only and immutable: writing adds files, {@link compact} replaces a
 * closed hour's files with one merged file (written before the inputs are deleted),
 * and retention deletes whole files. Rows inside a file are sorted by `created_at, id`
 * with ~10k-row groups and statistics on, so time-bounded reads skip row groups.
 *
 * This is the cold half of `storage.tiered()`; it is not a {@link TelescopeStore} on its
 * own because recording one entry at a time as Parquet would make one file per entry.
 */
export class ParquetColdStore {
  readonly location: ColdObjectStore;
  engine!: ColdReadEngine;
  readonly instanceId: string;
  private readonly libs: ParquetLibs;
  private readonly rowGroupSize: number;
  private readonly maxRowsPerFile: number;
  private readonly listingTtlMs: number;
  private readonly metadataCacheSize: number;
  private readonly compactPartitionsPerRun: number;
  private readonly listings = new Map<string, { at: number; files: Promise<ColdFile[]> }>();
  /** Small, per-file stats for every file seen (dropped when the file disappears). */
  private readonly stats = new Map<string, ColdFile>();
  /** Parsed footers, LRU-bounded (Map iteration order is insertion order). */
  private readonly footers = new Map<string, Promise<FileMetaData>>();

  /** Build a store and its engine (the engine may need async setup, e.g. DuckDB). */
  static async create(options: ParquetColdStoreOptions): Promise<ParquetColdStore> {
    const store = new ParquetColdStore(options);
    store.engine = await options.engine({
      location: store.location,
      libs: store.libs,
      metadata: (file) => store.metadata(file),
      buffer: (file) => store.buffer(file),
    });
    return store;
  }

  private constructor(options: ParquetColdStoreOptions) {
    this.location = options.location;
    this.libs = options.libs;
    this.instanceId = sanitizeInstanceId(options.instanceId ?? `${hostname()}-${process.pid}`);
    this.rowGroupSize = Math.max(1, options.rowGroupSize ?? 10_000);
    this.maxRowsPerFile = Math.max(this.rowGroupSize, options.maxRowsPerFile ?? 200_000);
    this.listingTtlMs = Math.max(0, options.listingTtlMs ?? 2_000);
    this.metadataCacheSize = Math.max(16, options.metadataCacheSize ?? 2_000);
    this.compactPartitionsPerRun = Math.max(0, options.compactPartitionsPerRun ?? 4);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Write entries as Parquet, one or more files per `(type, hour)`. Resolves to the keys
   * written, so a caller can delete them again if a later step of its own fails.
   */
  async write(entries: Entry[]): Promise<string[]> {
    const groups = new Map<string, { type: string; hourStartMs: number; rows: ParquetRow[] }>();
    for (const entry of entries) {
      const hs = hourStart(entry.createdAt.getTime());
      const groupKey = `${hs}\u0000${entry.type}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { type: entry.type, hourStartMs: hs, rows: [] };
        groups.set(groupKey, group);
      }
      group.rows.push(toParquetRow(entry, this.instanceId));
    }

    const written: string[] = [];
    try {
      for (const group of groups.values()) {
        group.rows.sort(compareRowsAscending);
        for (let i = 0; i < group.rows.length; i += this.maxRowsPerFile) {
          const key = `${partitionPrefix(group.type, group.hourStartMs)}${this.instanceId}-${randomUUID()}.parquet`;
          await this.location.write(key, this.encode(group.rows.slice(i, i + this.maxRowsPerFile)));
          written.push(key);
        }
      }
    } catch (error) {
      await this.location.delete(written).catch(() => undefined);
      throw error;
    } finally {
      this.listings.clear();
    }
    return written;
  }

  private encode(rows: ParquetRow[]): Uint8Array {
    const columnData = PARQUET_COLUMNS.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      data: rows.map((row) => row[column.name]),
      ...('bloomFilter' in column ? { bloomFilter: column.bloomFilter } : {}),
    }));
    const buffer = this.libs.writer.parquetWriteBuffer({
      // hyparquet-writer types `data` as its DecodedArray union; rows are plain arrays.
      columnData: columnData as unknown as Parameters<
        HyparquetWriter['parquetWriteBuffer']
      >[0]['columnData'],
      rowGroupSize: this.rowGroupSize,
      statistics: true,
      kvMetadata: [{ key: 'telescope.layout', value: '1' }],
      createdBy: '@adonis-agora/telescope',
    });
    return new Uint8Array(buffer);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Entries matching `query`, newest-first, honouring `{ page, size }`. */
  async list(query: EntryQuery = {}): Promise<Entry[]> {
    if (query.traceIds !== undefined && query.traceIds.length === 0) return [];
    const { offset, size } = resolvePage(query);
    const files = await this.candidates(query);
    const rows = await this.engine.list(
      files,
      query,
      size === undefined ? undefined : offset + size,
    );
    return size === undefined ? rows : rows.slice(offset, offset + size);
  }

  /** The newest `limit` matches with no page offset — what the tiered merge needs. */
  async top(query: EntryQuery, limit: number | undefined): Promise<Entry[]> {
    if (query.traceIds !== undefined && query.traceIds.length === 0) return [];
    return this.engine.list(await this.candidates(query), query, limit);
  }

  async get(id: string): Promise<Entry | null> {
    return this.engine.get(await this.candidates({}), id);
  }

  async listTraceIds(query: TraceIdQuery): Promise<TraceIdRow[]> {
    const size = Math.max(0, Math.floor(query.size));
    const offset = (Math.max(1, Math.floor(query.page ?? 1)) - 1) * size;
    const rows = await this.topTraceIds(query, offset + size);
    return rows.slice(offset, offset + size);
  }

  /** The `limit` most-recently-seen traces, no offset (for the tiered merge). */
  async topTraceIds(
    query: Pick<TraceIdQuery, 'before' | 'after'>,
    limit: number,
  ): Promise<TraceIdRow[]> {
    if (limit <= 0) return [];
    return this.engine.traceIds(await this.candidates(query), query, limit);
  }

  async countByBucket(query: BucketCountQuery): Promise<BucketCountRow[]> {
    // `after` is exclusive and `before` inclusive here; widen `before` by 1 ms so the
    // exclusive candidate pruning keeps the file holding the boundary row.
    const files = await this.candidates({
      ...(query.type !== undefined ? { type: query.type } : {}),
      after: query.after,
      before: new Date(query.before.getTime() + 1),
    });
    return this.engine.countByBucket(files, query);
  }

  /** Rows in the cold tier, from file footers (no rows are read). */
  async count(): Promise<number> {
    const files = await this.candidates({});
    return files.reduce((sum, file) => sum + file.numRows, 0);
  }

  /**
   * The newest `created_at` the cold tier could hold for `query`, or `null` when it holds
   * nothing for it. Lets the tiered store skip the cold tier when a page is already
   * filled by hot entries that are all newer.
   */
  async newestCreatedAt(query: EntryQuery): Promise<Date | null> {
    const files = await this.candidates(query);
    return files.length === 0 ? null : new Date(files[0]!.maxMs);
  }

  // ── Retention + compaction ───────────────────────────────────────────────

  /**
   * Delete every file whose whole hour is older than `olderThan`, keeping the newest
   * files of that doomed set until they hold at least `keepLast` rows. Retention is
   * file-granular: an hour stays until all of it has expired. Resolves to the rows
   * deleted.
   */
  async expire(olderThan: Date, keepLast?: number): Promise<number> {
    const cutoff = olderThan.getTime();
    const all = await this.listAll(true);
    const doomed = all
      .filter((file) => file.hourStartMs + HOUR_MS <= cutoff)
      .sort((a, b) => b.hourStartMs - a.hourStartMs || b.key.localeCompare(a.key));
    if (doomed.length === 0) return 0;

    let kept = 0;
    const toDelete: ColdFile[] = [];
    for (const file of doomed) {
      if (keepLast !== undefined && kept < keepLast) {
        kept += (await this.withStats(file))?.numRows ?? 0;
        continue;
      }
      toDelete.push(file);
    }
    let rows = 0;
    for (const file of toDelete) rows += (await this.withStats(file))?.numRows ?? 0;
    await this.location.delete(toDelete.map((file) => file.key));
    this.forget(toDelete.map((file) => file.key));
    return rows;
  }

  /**
   * Merge the files of closed hours (hours that ended before `closedBefore`) so each
   * holds one file per {@link ParquetColdStoreOptions.maxRowsPerFile} rows instead of
   * one per prune cycle. The merged file is written before its inputs are deleted, so
   * a reader never loses rows; one that lists in between sees both and the merge on
   * read drops the duplicate ids. Resolves to the number of input files replaced.
   */
  async compact(closedBefore: Date): Promise<number> {
    if (this.compactPartitionsPerRun === 0) return 0;
    const cutoff = closedBefore.getTime();
    const byPartition = new Map<string, ColdFile[]>();
    for (const file of await this.listAll(true)) {
      if (file.hourStartMs + HOUR_MS > cutoff) continue;
      const key = partitionPrefix(file.type, file.hourStartMs);
      const group = byPartition.get(key) ?? [];
      group.push(file);
      byPartition.set(key, group);
    }

    let replaced = 0;
    let partitions = 0;
    for (const files of byPartition.values()) {
      if (partitions >= this.compactPartitionsPerRun) break;
      const withStats = (await Promise.all(files.map((file) => this.withStats(file)))).filter(
        (file): file is ColdFile => file !== null,
      );
      // Only merge files that are small enough to be worth it, packed up to the file cap.
      const small = withStats
        .filter((file) => file.numRows < this.maxRowsPerFile)
        .sort((a, b) => a.minMs - b.minMs);
      const batches: ColdFile[][] = [];
      let current: ColdFile[] = [];
      let rows = 0;
      for (const file of small) {
        if (current.length > 0 && rows + file.numRows > this.maxRowsPerFile) {
          batches.push(current);
          current = [];
          rows = 0;
        }
        current.push(file);
        rows += file.numRows;
      }
      if (current.length > 0) batches.push(current);
      const toMerge = batches.filter((batch) => batch.length > 1);
      if (toMerge.length === 0) continue;
      partitions++;
      for (const batch of toMerge) {
        const entries = await this.engine.list(batch, {}, undefined);
        const unique = dedupeById(entries);
        await this.write(unique);
        await this.location.delete(batch.map((file) => file.key));
        this.forget(batch.map((file) => file.key));
        replaced += batch.length;
      }
    }
    return replaced;
  }

  /** Delete every file. */
  async clear(): Promise<void> {
    const all = await this.listAll(true);
    await this.location.delete(all.map((file) => file.key));
    this.forget(all.map((file) => file.key));
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  // ── Listing + footers ────────────────────────────────────────────────────

  /**
   * Files that can hold rows for `query`: its type's prefix only, hours outside the
   * time bounds dropped by partition, then files outside them dropped by footer stats.
   * Sorted newest-first by each file's newest row.
   */
  private async candidates(
    query: Pick<EntryQuery, 'type' | 'before' | 'after'>,
  ): Promise<ColdFile[]> {
    const before = query.before?.getTime();
    const after = query.after?.getTime();
    const listed = await this.list_(query.type);
    const byHour = listed.filter((file) => {
      if (query.type !== undefined && file.type !== query.type) return false;
      if (before !== undefined && file.hourStartMs >= before) return false;
      if (after !== undefined && file.hourStartMs + HOUR_MS - 1 <= after) return false;
      return true;
    });
    const resolved = await Promise.all(byHour.map((file) => this.withStats(file)));
    return resolved
      .filter((file): file is ColdFile => {
        if (file === null || file.numRows === 0) return false;
        if (before !== undefined && file.minMs >= before) return false;
        if (after !== undefined && file.maxMs <= after) return false;
        return true;
      })
      .sort((a, b) => b.maxMs - a.maxMs || b.key.localeCompare(a.key));
  }

  private list_(type: string | undefined): Promise<ColdFile[]> {
    const prefix = type === undefined ? '' : typePrefix(type);
    const now = Date.now();
    const cached = this.listings.get(prefix);
    if (cached && now - cached.at < this.listingTtlMs) return cached.files;
    const files = this.location.list(prefix).then((objects) => {
      const out: ColdFile[] = [];
      for (const object of objects) {
        const partition = parsePartition(object.key);
        if (!partition) continue;
        out.push(
          this.stats.get(object.key) ?? {
            key: object.key,
            size: object.size,
            type: partition.type,
            hourStartMs: partition.hourStartMs,
            numRows: -1,
            minMs: partition.hourStartMs,
            maxMs: partition.hourStartMs + HOUR_MS - 1,
            rowGroups: [],
          },
        );
      }
      return out;
    });
    files.catch(() => this.listings.delete(prefix));
    this.listings.set(prefix, { at: now, files });
    return files;
  }

  private async listAll(fresh: boolean): Promise<ColdFile[]> {
    if (fresh) this.listings.clear();
    return this.list_(undefined);
  }

  /** The file with footer stats filled in, or `null` when it no longer exists. */
  private async withStats(file: ColdFile): Promise<ColdFile | null> {
    if (file.numRows >= 0) return file;
    const known = this.stats.get(file.key);
    if (known) return known;
    let meta: FileMetaData;
    try {
      meta = await this.metadata(file);
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const full = { ...file, ...statsFromFooter(meta, file) };
    this.stats.set(file.key, full);
    return full;
  }

  /** Parsed footer for a file, through a bounded LRU. */
  metadata(file: ColdFile): Promise<FileMetaData> {
    const hit = this.footers.get(file.key);
    if (hit) {
      this.footers.delete(file.key);
      this.footers.set(file.key, hit);
      return hit;
    }
    const pending = this.libs.hyparquet.parquetMetadataAsync(this.buffer(file));
    pending.catch(() => this.footers.delete(file.key));
    this.footers.set(file.key, pending);
    while (this.footers.size > this.metadataCacheSize) {
      const oldest = this.footers.keys().next().value;
      if (oldest === undefined) break;
      this.footers.delete(oldest);
    }
    return pending;
  }

  buffer(file: ColdFile): AsyncBuffer {
    const location = this.location;
    return {
      byteLength: file.size,
      async slice(start: number, end?: number): Promise<ArrayBuffer> {
        const bytes = await location.read(file.key, start, end);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
    };
  }

  private forget(keys: string[]): void {
    for (const key of keys) {
      this.stats.delete(key);
      this.footers.delete(key);
    }
    this.listings.clear();
  }
}

/**
 * Load the hyparquet trio. They are optional peers (only `storage.tiered()` needs them),
 * so a missing one fails boot with a message naming it.
 */
export async function loadParquetLibs(): Promise<ParquetLibs> {
  const neededBy = 'storage.parquet()';
  const [hyparquet, writer, compressorsModule] = await Promise.all([
    importOptionalPeer('hyparquet', neededBy, () => import('hyparquet')),
    importOptionalPeer('hyparquet-writer', neededBy, () => import('hyparquet-writer')),
    importOptionalPeer('hyparquet-compressors', neededBy, () => import('hyparquet-compressors')),
  ]);
  return { hyparquet, writer, compressors: compressorsModule.compressors };
}

function statsFromFooter(
  meta: FileMetaData,
  file: ColdFile,
): Pick<ColdFile, 'numRows' | 'minMs' | 'maxMs' | 'rowGroups'> {
  const createdAtIndex = meta.schema.slice(1).findIndex((element) => element.name === 'created_at');
  const rowGroups: RowGroupStats[] = [];
  let rowStart = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const group of meta.row_groups) {
    const rows = Number(group.num_rows);
    const statistics = group.columns[createdAtIndex]?.meta_data?.statistics;
    const lo = statValue(statistics?.min_value ?? statistics?.min, file.hourStartMs);
    const hi = statValue(statistics?.max_value ?? statistics?.max, file.hourStartMs + HOUR_MS - 1);
    rowGroups.push({ rowStart, rowEnd: rowStart + rows, minMs: lo, maxMs: hi });
    minMs = Math.min(minMs, lo);
    maxMs = Math.max(maxMs, hi);
    rowStart += rows;
  }
  if (rowGroups.length === 0) {
    minMs = file.hourStartMs;
    maxMs = file.hourStartMs;
  }
  return { numRows: Number(meta.num_rows), minMs, maxMs, rowGroups };
}

function statValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const ms = toDate(value).getTime();
  return Number.isFinite(ms) ? ms : fallback;
}

function compareRowsAscending(a: ParquetRow, b: ParquetRow): number {
  const t = a.created_at.getTime() - b.created_at.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Keep the first occurrence of each id (callers pass newest-first lists). */
export function dedupeById(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** Merge newest-first lists into one newest-first list without duplicate ids. */
export function mergeNewestFirst(...lists: Entry[][]): Entry[] {
  return dedupeById(lists.flat().sort(compareNewestFirst));
}

function sanitizeInstanceId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, '_');
  return clean === '' ? 'telescope' : clean;
}
