import type { Entry } from '../entry.js';
import type { BucketCountQuery, BucketCountRow, EntryQuery, TraceIdRow } from '../store.js';
import type { ColdEngineContext, ColdFile, ColdReadEngine, RowGroupStats } from './parquet.js';
import { compareNewestFirst, fromParquetRow, toDate } from './parquet_format.js';
import { isNotFound } from './parquet_location.js';

type ParquetQueryFilter = import('hyparquet').ParquetQueryFilter;

/**
 * The default cold engine: pure JavaScript (hyparquet), nothing native and nothing
 * fetched at runtime.
 *
 * Reads walk files newest-first and, inside each file, row groups newest-first,
 * skipping any group whose `created_at` statistics fall outside the query, and stop
 * as soon as the page is full and nothing older can still outrank it. Equality
 * filters on `id` / `trace_id` also consult the bloom filters the writer emits.
 */
export class HyparquetEngine implements ColdReadEngine {
  readonly name = 'hyparquet' as const;

  constructor(private readonly ctx: ColdEngineContext) {}

  async list(files: ColdFile[], query: EntryQuery, limit: number | undefined): Promise<Entry[]> {
    let results: Entry[] = [];
    const filter = pushdownFilter(query);
    // Bloom filters exist for `trace_id` (and `id`); they pay off on point lookups only.
    const useBloom = query.traceId !== undefined || query.traceIds !== undefined;
    const before = query.before?.getTime();
    const after = query.after?.getTime();
    const full = () => limit !== undefined && results.length >= limit;
    const floor = () => results[results.length - 1]!.createdAt.getTime();

    for (const file of files) {
      if (full() && file.maxMs < floor()) break;
      for (const group of newestGroups(file, before, after)) {
        if (full() && group.maxMs < floor()) break;
        const rows = await this.readGroup(file, group, undefined, filter, useBloom);
        for (const row of rows) {
          if (!rowMatches(row, query)) continue;
          results.push(fromParquetRow(row));
        }
        results.sort(compareNewestFirst);
        if (limit !== undefined && results.length > limit) results = results.slice(0, limit);
      }
    }
    return results;
  }

  async get(files: ColdFile[], id: string): Promise<Entry | null> {
    const filter: ParquetQueryFilter = { id: { $eq: id } };
    for (const file of files) {
      for (const group of newestGroups(file, undefined, undefined)) {
        const rows = await this.readGroup(file, group, undefined, filter, true);
        const hit = rows.find((row) => row.id === id);
        if (hit) return fromParquetRow(hit);
      }
    }
    return null;
  }

  async traceIds(
    files: ColdFile[],
    query: { before?: Date; after?: Date },
    limit: number,
  ): Promise<TraceIdRow[]> {
    const lastAt = new Map<string, number>();
    const before = query.before?.getTime();
    const after = query.after?.getTime();
    // Once `limit` traces are newer than everything left to read, nothing older can enter.
    const kth = (): number => {
      if (lastAt.size < limit) return Number.NEGATIVE_INFINITY;
      return [...lastAt.values()].sort((a, b) => b - a)[limit - 1]!;
    };

    for (const file of files) {
      if (file.maxMs < kth()) break;
      for (const group of newestGroups(file, before, after)) {
        if (group.maxMs < kth()) break;
        const rows = await this.readGroup(file, group, ['trace_id', 'created_at']);
        for (const row of rows) {
          if (row.trace_id == null) continue;
          const at = toDate(row.created_at).getTime();
          if (before !== undefined && !(at < before)) continue;
          if (after !== undefined && !(at > after)) continue;
          const traceId = String(row.trace_id);
          const seen = lastAt.get(traceId);
          if (seen === undefined || at > seen) lastAt.set(traceId, at);
        }
      }
    }
    return [...lastAt.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([traceId, at]) => ({ traceId, lastAt: new Date(at) }));
  }

  async countByBucket(files: ColdFile[], query: BucketCountQuery): Promise<BucketCountRow[]> {
    const startMs = query.after.getTime();
    const endMs = query.before.getTime();
    const bucketMs = Math.max(1, Math.floor(query.bucketMs));
    const tally = new Map<string, BucketCountRow>();
    for (const file of files) {
      for (const group of newestGroups(file, endMs + 1, startMs)) {
        const rows = await this.readGroup(file, group, ['type', 'created_at']);
        for (const row of rows) {
          const type = String(row.type);
          if (query.type !== undefined && type !== query.type) continue;
          const at = toDate(row.created_at).getTime();
          if (at <= startMs || at > endMs) continue;
          const index = Math.floor((at - startMs) / bucketMs);
          const key = `${index}\u0000${type}`;
          const seen = tally.get(key);
          if (seen === undefined) tally.set(key, { index, type, count: 1 });
          else seen.count += 1;
        }
      }
    }
    return [...tally.values()];
  }

  async close(): Promise<void> {}

  /** One row group as plain objects; a file that vanished since listing reads as empty. */
  private async readGroup(
    file: ColdFile,
    group: RowGroupStats,
    columns: string[] | undefined,
    filter?: ParquetQueryFilter,
    useBloomFilters = false,
  ): Promise<Record<string, unknown>[]> {
    const { hyparquet, compressors } = this.ctx.libs;
    try {
      const metadata = await this.ctx.metadata(file);
      return (await hyparquet.parquetReadObjects({
        file: hyparquet.cachedAsyncBuffer(this.ctx.buffer(file)),
        metadata,
        compressors,
        rowStart: group.rowStart,
        rowEnd: group.rowEnd,
        ...(columns !== undefined ? { columns } : {}),
        ...(filter !== undefined ? { filter, useBloomFilters } : {}),
      })) as Record<string, unknown>[];
    } catch (error: unknown) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
}

/** A file's row groups that overlap `(after, before)`, newest first. */
function newestGroups(
  file: ColdFile,
  before: number | undefined,
  after: number | undefined,
): RowGroupStats[] {
  return file.rowGroups
    .filter((group) => {
      if (before !== undefined && group.minMs >= before) return false;
      if (after !== undefined && group.maxMs <= after) return false;
      return true;
    })
    .sort((a, b) => b.maxMs - a.maxMs);
}

/**
 * The equality predicates hyparquet can evaluate itself (and use to skip row groups).
 * Everything else is checked in {@link rowMatches}.
 */
function pushdownFilter(query: EntryQuery): ParquetQueryFilter | undefined {
  const clauses: ParquetQueryFilter[] = [];
  if (query.type !== undefined) clauses.push({ type: { $eq: query.type } });
  if (query.familyHash !== undefined) clauses.push({ family_hash: { $eq: query.familyHash } });
  if (query.traceId !== undefined) clauses.push({ trace_id: { $eq: query.traceId } });
  if (query.traceIds !== undefined) clauses.push({ trace_id: { $in: query.traceIds } });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/**
 * Every {@link EntryQuery} predicate, evaluated on the stored row before it is parsed.
 * `tag` matches the quoted token inside the JSON text and `search` is a lower-cased
 * substring over `content` and `tags` — the same semantics as the Lucid store.
 */
export function rowMatches(row: Record<string, unknown>, query: EntryQuery): boolean {
  if (query.type !== undefined && row.type !== query.type) return false;
  if (query.familyHash !== undefined && row.family_hash !== query.familyHash) return false;
  if (query.traceId !== undefined && row.trace_id !== query.traceId) return false;
  if (query.traceIds !== undefined) {
    if (typeof row.trace_id !== 'string' || !query.traceIds.includes(row.trace_id)) return false;
  }
  if (query.before !== undefined || query.after !== undefined) {
    const at = toDate(row.created_at).getTime();
    if (query.before !== undefined && !(at < query.before.getTime())) return false;
    if (query.after !== undefined && !(at > query.after.getTime())) return false;
  }
  const tags = String(row.tags ?? '');
  if (query.tag !== undefined && !tags.includes(JSON.stringify(query.tag))) return false;
  if (query.search !== undefined) {
    const needle = query.search.toLowerCase();
    if (
      !String(row.content ?? '')
        .toLowerCase()
        .includes(needle) &&
      !tags.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  return true;
}
