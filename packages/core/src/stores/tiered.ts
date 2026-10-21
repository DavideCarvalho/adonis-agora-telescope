import type { Entry, RecordInput } from '../entry.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  TelescopeStore,
  TraceIdQuery,
  TraceIdRow,
} from '../store.js';
import { mergeNewestFirst, type ParquetColdStore } from './parquet.js';
import { resolvePage } from './parquet_format.js';

/** Where the tiered store reports cold-tier trouble. Defaults to `console`. */
export interface TieredStoreLogger {
  warn(message: string): void;
}

/** Options for {@link TieredTelescopeStore}. */
export interface TieredStoreOptions {
  /** The live store every entry is recorded into, e.g. the app's database via Lucid. */
  hot: TelescopeStore;
  /** Where entries go once they are older than {@link hotForMs}. */
  cold: ParquetColdStore;
  /** How long an entry stays in the hot store, in ms. */
  hotForMs: number;
  /** Hot entries read per page while moving them to cold. Default 5,000. */
  moveBatchSize?: number;
  /** Entries buffered before a move writes them out as files. Default 50,000. */
  moveFlushSize?: number;
  /** Merge each closed hour's small files during prune. Default `true`. */
  compact?: boolean;
  logger?: TieredStoreLogger;
}

/** What the most recent {@link TieredTelescopeStore.prune} did. */
export interface TieredPruneReport {
  /** Hot entries written to the cold tier. */
  moved: number;
  /** Entries deleted from the hot tier (moved ones included). */
  hotDeleted: number;
  /** Cold rows deleted by retention. */
  coldExpired: number;
  /** Cold files replaced by compaction. */
  compactedFiles: number;
  /** A cold-tier failure during the cycle, when there was one. */
  error?: string;
}

/**
 * A two-tier {@link TelescopeStore}: a hot store kept minutes deep and a Parquet cold
 * tier for everything older.
 *
 * - **Writes** only reach the hot store.
 * - **`prune(olderThan, keepLast)`** first moves hot entries older than
 *   `now - hotFor` (and newer than `olderThan`) to cold, deleting them from hot only
 *   after the files are written; then applies the retention cutoff to the cold tier
 *   (whole hourly files); then compacts closed hours. A failed write deletes the files
 *   it wrote and leaves the hot store untouched, so the next cycle retries.
 * - **Reads** go to hot first and to cold for whatever the answer still needs, merged
 *   newest-first without duplicate ids, so `{ page, size }` pages straight across the
 *   tier boundary. If the cold tier cannot be read, hot results are returned and a
 *   warning is logged; the dashboard never fails because of the cold tier.
 */
export class TieredTelescopeStore implements TelescopeStore {
  readonly hot: TelescopeStore;
  readonly cold: ParquetColdStore;
  private readonly hotForMs: number;
  private readonly moveBatchSize: number;
  private readonly moveFlushSize: number;
  private readonly compactEnabled: boolean;
  private readonly logger: TieredStoreLogger;
  private lastWarnAt = 0;
  private report: TieredPruneReport | null = null;

  constructor(options: TieredStoreOptions) {
    if (!(options.hotForMs > 0)) {
      throw new Error('@adonis-agora/telescope: storage.tiered() needs a positive `hotFor`.');
    }
    this.hot = options.hot;
    this.cold = options.cold;
    this.hotForMs = options.hotForMs;
    this.moveBatchSize = Math.max(1, Math.floor(options.moveBatchSize ?? 5_000));
    this.moveFlushSize = Math.max(this.moveBatchSize, Math.floor(options.moveFlushSize ?? 50_000));
    this.compactEnabled = options.compact ?? true;
    this.logger = options.logger ?? console;
  }

  record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    return this.hot.record(input);
  }

  async get(id: string): Promise<Entry | null> {
    const hot = await this.hot.get(id);
    if (hot) return hot;
    return this.coldRead('get', () => this.cold.get(id), null);
  }

  async list(query: EntryQuery = {}): Promise<Entry[]> {
    const { offset, size } = resolvePage(query);
    const { page: _page, size: _size, ...filters } = query;

    if (size === undefined) {
      const [hot, cold] = await Promise.all([
        this.hot.list(filters),
        this.coldRead('list', () => this.cold.top(filters, undefined), []),
      ]);
      return mergeNewestFirst(hot, cold);
    }

    // Each tier's newest `offset + size` is enough to produce the page from their merge.
    const need = offset + size;
    const hot = await this.hot.list({ ...filters, page: 1, size: need });
    if (hot.length === need) {
      const oldestHot = hot[hot.length - 1]!.createdAt;
      const newestCold = await this.coldRead(
        'list',
        () => this.cold.newestCreatedAt(filters),
        null,
      );
      if (newestCold === null || newestCold < oldestHot) return hot.slice(offset, need);
    }
    const cold = await this.coldRead('list', () => this.cold.top(filters, need), []);
    return mergeNewestFirst(hot, cold).slice(offset, need);
  }

  async count(): Promise<number> {
    const [hot, cold] = await Promise.all([
      this.hot.count(),
      this.coldRead('count', () => this.cold.count(), 0),
    ]);
    return hot + cold;
  }

  /**
   * The union's top traces: each tier's top `offset + size` by last-seen, merged by the
   * newer of the two timestamps. A trace in the union's top N is necessarily in the top
   * N of the tier where it was last seen, so nothing is missed.
   */
  async listTraceIds(query: TraceIdQuery): Promise<TraceIdRow[]> {
    const size = Math.max(0, Math.floor(query.size));
    const offset = (Math.max(1, Math.floor(query.page ?? 1)) - 1) * size;
    const need = offset + size;
    if (need === 0) return [];
    const window = {
      ...(query.before !== undefined ? { before: query.before } : {}),
      ...(query.after !== undefined ? { after: query.after } : {}),
    };
    const [hot, cold] = await Promise.all([
      this.hot.listTraceIds
        ? this.hot.listTraceIds({ ...window, size: need, page: 1 })
        : traceIdsFromList(await this.hot.list(window), need),
      this.coldRead('listTraceIds', () => this.cold.topTraceIds(window, need), []),
    ]);
    const lastAt = new Map<string, number>();
    for (const row of [...hot, ...cold]) {
      const at = row.lastAt.getTime();
      const seen = lastAt.get(row.traceId);
      if (seen === undefined || at > seen) lastAt.set(row.traceId, at);
    }
    return [...lastAt.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(offset, need)
      .map(([traceId, at]) => ({ traceId, lastAt: new Date(at) }));
  }

  async countByBucket(query: BucketCountQuery): Promise<BucketCountRow[]> {
    const [hot, cold] = await Promise.all([
      this.hot.countByBucket ? this.hot.countByBucket(query) : this.bucketsFromHotList(query),
      this.coldRead('countByBucket', () => this.cold.countByBucket(query), []),
    ]);
    const tally = new Map<string, BucketCountRow>();
    for (const row of [...hot, ...cold]) {
      const key = `${row.index}\u0000${row.type}`;
      const seen = tally.get(key);
      if (seen === undefined) tally.set(key, { ...row });
      else seen.count += row.count;
    }
    return [...tally.values()];
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const hotCutoff = new Date(Date.now() - this.hotForMs);
    const report: TieredPruneReport = {
      moved: 0,
      hotDeleted: 0,
      coldExpired: 0,
      compactedFiles: 0,
    };
    this.report = report;

    if (hotCutoff > olderThan) {
      // Move-then-delete. A failure in `moveToCold` leaves the hot store as it was.
      // With `keepLast`, hot entries already past retention move too, so the cold
      // tier's expiry applies the count across both tiers.
      const moveAfter = keepLast === undefined ? olderThan : new Date(0);
      report.moved = await this.moveToCold(moveAfter, hotCutoff);
      report.hotDeleted = await this.hot.prune(hotCutoff);
    } else {
      // Retention is shorter than the hot window: nothing ever reaches cold.
      report.hotDeleted = await this.hot.prune(olderThan, keepLast);
    }

    try {
      report.coldExpired = await this.cold.expire(olderThan, keepLast);
      if (this.compactEnabled) report.compactedFiles = await this.cold.compact(hotCutoff);
    } catch (error: unknown) {
      report.error = message(error);
      this.logger.warn(`Telescope cold tier maintenance failed: ${report.error}`);
    }
    return Math.max(0, report.hotDeleted - report.moved) + report.coldExpired;
  }

  /** What the last prune cycle moved, deleted and compacted (null before the first). */
  lastPrune(): TieredPruneReport | null {
    return this.report ? { ...this.report } : null;
  }

  async clear(): Promise<void> {
    await Promise.all([this.hot.clear(), this.cold.clear()]);
  }

  /** Release the cold engine (DuckDB holds a native instance). */
  async close(): Promise<void> {
    await this.cold.close();
  }

  /**
   * Copy hot entries in `[after, before)` to cold. Pages are offset-based over a fixed
   * window that nothing is deleted from until the whole move succeeded, so no entry is
   * skipped; entries reach the window only by ageing past `before`, after this cycle's
   * snapshot. Resolves to the number of entries written.
   */
  private async moveToCold(after: Date, before: Date): Promise<number> {
    const window: EntryQuery = { after: new Date(after.getTime() - 1), before };
    const written: string[] = [];
    let buffered: Entry[] = [];
    let moved = 0;
    try {
      for (let page = 1; ; page++) {
        const rows = await this.hot.list({ ...window, page, size: this.moveBatchSize });
        buffered.push(...rows);
        if (
          buffered.length >= this.moveFlushSize ||
          (rows.length < this.moveBatchSize && buffered.length > 0)
        ) {
          written.push(...(await this.cold.write(buffered)));
          moved += buffered.length;
          buffered = [];
        }
        if (rows.length < this.moveBatchSize) break;
      }
    } catch (error) {
      await this.cold.location.delete(written).catch(() => undefined);
      throw error;
    }
    return moved;
  }

  private async bucketsFromHotList(query: BucketCountQuery): Promise<BucketCountRow[]> {
    const startMs = query.after.getTime();
    const bucketMs = Math.max(1, Math.floor(query.bucketMs));
    const rows = await this.hot.list({
      after: query.after,
      before: new Date(query.before.getTime() + 1),
      ...(query.type !== undefined ? { type: query.type } : {}),
    });
    const tally = new Map<string, BucketCountRow>();
    for (const entry of rows) {
      const index = Math.floor((entry.createdAt.getTime() - startMs) / bucketMs);
      const key = `${index}\u0000${entry.type}`;
      const seen = tally.get(key);
      if (seen === undefined) tally.set(key, { index, type: entry.type, count: 1 });
      else seen.count += 1;
    }
    return [...tally.values()];
  }

  /** Run a cold read; on failure log (at most once a minute) and use `fallback`. */
  private async coldRead<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      const now = Date.now();
      if (now - this.lastWarnAt > 60_000) {
        this.lastWarnAt = now;
        this.logger.warn(
          `Telescope cold tier unavailable (${what}); serving hot entries only: ${message(error)}`,
        );
      }
      return fallback;
    }
  }
}

function traceIdsFromList(entries: Entry[], limit: number): TraceIdRow[] {
  const lastAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.traceId === null) continue;
    const at = entry.createdAt.getTime();
    const seen = lastAt.get(entry.traceId);
    if (seen === undefined || at > seen) lastAt.set(entry.traceId, at);
  }
  return [...lastAt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([traceId, at]) => ({ traceId, lastAt: new Date(at) }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
