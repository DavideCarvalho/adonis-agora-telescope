/**
 * Pre-aggregated latency histogram + percentile estimation. Ported faithfully
 * from `nestjs-telescope`'s `rollup/rollup-store.ts` (the boundaries + histogram
 * helpers) and `rollup/estimate-percentile.ts` (the bucket-resolution percentile).
 *
 * This is the storage-agnostic maths only — there is no rollup STORE in the
 * Adonis port (the headless store has no rollup SPI). It exists so the metrics
 * module can offer a histogram-based percentile path whose estimate agrees with
 * the raw-scan nearest-rank percentile within one bucket-width (see the
 * equivalence spec), exactly mirroring the NestJS invariants.
 */

/** One minute is the base rollup granularity. */
export const ROLLUP_BUCKET_MS = 60_000;

/**
 * Upper boundaries (inclusive, in ms) for the pre-aggregated latency histogram.
 * Bucket `i` counts durations `d` where `d <= LATENCY_BOUNDARIES_MS[i]` and
 * `d > LATENCY_BOUNDARIES_MS[i-1]`. A final OVERFLOW bucket counts everything
 * greater than the last boundary, so a histogram always has
 * `LATENCY_BOUNDARIES_MS.length + 1` cells.
 */
export const LATENCY_BOUNDARIES_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/** The fixed cell count of every latency histogram (boundaries + 1 overflow). */
export const HISTOGRAM_BUCKET_COUNT = LATENCY_BOUNDARIES_MS.length + 1;

/** A fresh, all-zeros histogram of the canonical fixed length. */
export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKET_COUNT).fill(0);
}

/**
 * The histogram cell a duration falls in: the first index `i` where
 * `durationMs <= LATENCY_BOUNDARIES_MS[i]`, else the overflow index. Negative or
 * zero durations land in cell 0.
 */
export function histogramBucketIndex(durationMs: number): number {
  for (let index = 0; index < LATENCY_BOUNDARIES_MS.length; index += 1) {
    const boundary = LATENCY_BOUNDARIES_MS[index];
    if (boundary !== undefined && durationMs <= boundary) return index;
  }
  return LATENCY_BOUNDARIES_MS.length;
}

/** Increments the histogram cell for `durationMs` by one, in place. */
export function incrementHistogram(histogram: number[], durationMs: number): void {
  const index = histogramBucketIndex(durationMs);
  histogram[index] = (histogram[index] ?? 0) + 1;
}

/**
 * Normalizes a (possibly legacy/undefined) histogram into a fixed-length
 * zero-padded array — never NaN, never a wrong width.
 */
export function normalizeHistogram(histogram: number[] | null | undefined): number[] {
  const normalized = emptyHistogram();
  if (!Array.isArray(histogram)) return normalized;
  for (let index = 0; index < HISTOGRAM_BUCKET_COUNT; index += 1) {
    const value = histogram[index];
    normalized[index] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return normalized;
}

/**
 * Element-wise additive merge of `addend` into a fresh histogram. Both are
 * normalized first, so legacy/short arrays are safe.
 */
export function mergeHistograms(target: number[], addend: number[] | null | undefined): number[] {
  const left = normalizeHistogram(target);
  const right = normalizeHistogram(addend);
  for (let index = 0; index < HISTOGRAM_BUCKET_COUNT; index += 1) {
    left[index] = (left[index] ?? 0) + (right[index] ?? 0);
  }
  return left;
}

/** Build a latency histogram from raw durations (ms). */
export function buildHistogram(durations: Iterable<number>): number[] {
  const histogram = emptyHistogram();
  for (const duration of durations) incrementHistogram(histogram, duration);
  return histogram;
}

/**
 * Estimates a percentile from a pre-aggregated latency histogram (O(buckets), no
 * raw scan). Nearest-rank style at BUCKET resolution: the result is the UPPER
 * boundary of the bucket that contains the target rank, so the estimate is an
 * APPROXIMATION whose error is bounded by that bucket's width.
 *
 * - `total = Σ histogram`; `target rank = ceil(fraction * total)` (1-based,
 *   matching the raw nearest-rank `Math.ceil(fraction * n)`).
 * - Walk the cumulative count until it reaches/crosses the target rank; return
 *   the containing bucket's upper boundary.
 * - The OVERFLOW bucket has no finite upper boundary; we return the LAST boundary
 *   as a safe finite representative (documented under-estimate, never `Infinity`).
 * - Returns 0 when the histogram is empty / total is 0.
 */
export function estimatePercentileFromHistogram(histogram: number[], fraction: number): number {
  const cells = normalizeHistogram(histogram);
  let total = 0;
  for (const count of cells) total += count;
  if (total <= 0) return 0;

  const boundedFraction = Math.min(1, Math.max(0, fraction));
  const targetRank = Math.max(1, Math.ceil(boundedFraction * total));

  const lastBoundary = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;

  let cumulative = 0;
  for (let index = 0; index < cells.length; index += 1) {
    cumulative += cells[index] ?? 0;
    if (cumulative >= targetRank) {
      return LATENCY_BOUNDARIES_MS[index] ?? lastBoundary;
    }
  }
  return lastBoundary;
}
