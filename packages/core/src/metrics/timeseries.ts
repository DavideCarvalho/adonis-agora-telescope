import type { Entry } from '../entry.js';
import type { BucketCountRow } from '../store.js';

/** A single time-bucket of a {@link TimeseriesReport}. */
export interface TimeseriesBucket {
  /** ISO timestamp of the bucket's start. */
  t: string;
  total: number;
  byType: Record<string, number>;
}

export interface TimeseriesReport {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TimeseriesBucket[];
}

/**
 * Group entries into `bucketCount` equal time buckets across [windowStart,
 * windowEnd], counting total + per-type per bucket. Ported from `nestjs-telescope`'s
 * `metrics/timeseries.ts`. Pure: callers fetch the windowed entries.
 * Out-of-range entries are clamped into the edge buckets.
 */
export function bucketTimeseries(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): TimeseriesReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  const bucketMs = Math.max(1, Math.floor(spanMs / count));

  const buckets: TimeseriesBucket[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(startMs + index * bucketMs).toISOString(),
    total: 0,
    byType: {},
  }));

  for (const entry of entries) {
    const offset = entry.createdAt.getTime() - startMs;
    const rawIndex = Math.floor(offset / bucketMs);
    const index = Math.min(count - 1, Math.max(0, rawIndex));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byType[entry.type] = (bucket.byType[entry.type] ?? 0) + 1;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
  };
}

/**
 * The same report, built from per-bucket COUNTS instead of from entries.
 *
 * The store can produce those counts without shipping the entries themselves (see
 * {@link TelescopeStore.countByBucket}); this is the assembler for that path. It is
 * kept beside `bucketTimeseries` so the two stay in step — they must agree on bucket
 * width, on the clamping of out-of-range rows into the edge buckets, and on the
 * shape of the result, or the chart would change depending on which store you use.
 *
 * Pure.
 */
export function bucketTimeseriesFromCounts(
  rows: readonly BucketCountRow[],
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): TimeseriesReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  const bucketMs = Math.max(1, Math.floor(spanMs / count));

  const buckets: TimeseriesBucket[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(startMs + index * bucketMs).toISOString(),
    total: 0,
    byType: {},
  }));

  for (const row of rows) {
    // Same clamp as the entry path: a row landing past the last bucket (the window
    // end is inclusive, so `before` itself lands one past) belongs to the edge.
    const index = Math.min(count - 1, Math.max(0, row.index));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += row.count;
    bucket.byType[row.type] = (bucket.byType[row.type] ?? 0) + row.count;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
  };
}
