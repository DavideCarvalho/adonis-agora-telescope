import type { Entry } from '../entry.js';
import {
  type NPlusOneInsight,
  type NPlusOnePattern,
  detectNPlusOne,
  detectNPlusOnePatterns,
} from '../query/n_plus_one.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import { type StatsResult, estimateLatencyPercentiles, summarizeStats } from './stats.js';
import { type TimeseriesReport, bucketTimeseries } from './timeseries.js';
import { type TraceSummary, summarizeTraces } from './traces.js';
import { type Waterfall, buildWaterfall } from './waterfall.js';

const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 500;
const DEFAULT_SLOW_MS = 100;
/** Safety cap on entries scanned per analytics request; surfaced via `truncated`. */
const DEFAULT_SCAN_CAP = 50_000;
const DEFAULT_NPLUSONE_THRESHOLD = 3;

export interface StatsQuery {
  /** Required — stats are computed per entry type. */
  type: string;
  windowMs: number;
  buckets?: number;
}

export interface TimeseriesQuery {
  windowMs: number;
  buckets?: number;
  /** Optionally scope the series to a single entry type. */
  type?: string;
}

export interface MetricsServiceOptions {
  /** Threshold (ms) at/above which an entry counts as slow. Default 100. */
  slowMs?: number;
  defaultBuckets?: number;
  scanCap?: number;
  /** Minimum repetitions to flag an N+1 loop. Default 3. */
  nPlusOneThreshold?: number;
}

/**
 * Read-only analytics over the {@link TelescopeStore}: per-type stats (latency
 * percentiles, family/cache/status/exception breakdowns), throughput timeseries,
 * a trace list, a per-trace span waterfall, and N+1 query detection.
 *
 * Storage-agnostic — it works through the {@link TelescopeStore.list} interface
 * only (newest-first), never a specific provider. Analysis reads ALREADY-redacted
 * stored entries, so redaction is never bypassed.
 */
export class MetricsService {
  private readonly slowMs: number;
  private readonly defaultBuckets: number;
  private readonly scanCap: number;
  private readonly nPlusOneThreshold: number;

  constructor(
    private readonly store: TelescopeStore,
    options: MetricsServiceOptions = {},
  ) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.defaultBuckets = options.defaultBuckets ?? DEFAULT_BUCKETS;
    this.scanCap = options.scanCap ?? DEFAULT_SCAN_CAP;
    this.nPlusOneThreshold = options.nPlusOneThreshold ?? DEFAULT_NPLUSONE_THRESHOLD;
  }

  /** Per-type analytics over a trailing window. */
  async getStats(query: StatsQuery): Promise<StatsResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const buckets = this.clampBuckets(query.buckets);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);

    const { entries, truncated } = await this.collect({
      type: query.type,
      after: windowStart,
    });

    // Histogram-based percentile estimate over the windowed durations — the
    // storage-agnostic stand-in for the NestJS rollup fast path. count/max/slow
    // stay raw-derived inside summarizeStats.
    const durations = entries
      .map((entry) => entry.durationMs)
      .filter((d): d is number => typeof d === 'number');
    const latencyPercentiles = estimateLatencyPercentiles(durations);

    return summarizeStats({
      entries,
      type: query.type,
      windowStart,
      windowEnd,
      windowMs: query.windowMs,
      buckets,
      slowMs: this.slowMs,
      truncated,
      ...(latencyPercentiles !== undefined ? { latencyPercentiles } : {}),
    });
  }

  /** Throughput time-series over a trailing window (total + per-type per bucket). */
  async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesReport> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const buckets = this.clampBuckets(query.buckets);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);
    const { entries } = await this.collect({
      after: windowStart,
      ...(query.type !== undefined ? { type: query.type } : {}),
    });
    return bucketTimeseries(entries, windowStart, windowEnd, buckets);
  }

  /** Recent traces, newest-last-seen first. */
  async getTraces(limit = 50): Promise<TraceSummary[]> {
    const { entries } = await this.collect({});
    return summarizeTraces(entries, { limit });
  }

  /** The span waterfall for a single trace, or `null` when the trace is empty. */
  async getWaterfall(traceId: string): Promise<Waterfall | null> {
    const entries = await this.store.list({ traceId });
    return buildWaterfall(entries);
  }

  /**
   * N+1 query patterns within a single trace (loop attribution + wasted-time
   * ranking). The store returns newest-first; the detector needs oldest-first
   * record order to attribute the driving parent, so we reverse.
   */
  async getNPlusOne(traceId: string, threshold?: number): Promise<NPlusOnePattern[]> {
    const entries = await this.store.list({ traceId });
    const ordered = [...entries].reverse();
    return detectNPlusOnePatterns(ordered, {
      threshold: threshold ?? this.nPlusOneThreshold,
    });
  }

  /** Flat family-count N+1 insights within a single trace. */
  async getNPlusOneFlat(traceId: string, threshold?: number): Promise<NPlusOneInsight[]> {
    const entries = await this.store.list({ traceId });
    const ordered = [...entries].reverse();
    return detectNPlusOne(ordered, threshold ?? this.nPlusOneThreshold);
  }

  private clampBuckets(buckets: number | undefined): number {
    return Math.min(MAX_BUCKETS, Math.max(1, Math.floor(buckets ?? this.defaultBuckets)));
  }

  /** Fetch entries matching `query` (newest-first), capped at `scanCap`. */
  private async collect(query: EntryQuery): Promise<{ entries: Entry[]; truncated: boolean }> {
    const entries = await this.store.list({ ...query, limit: this.scanCap });
    return { entries, truncated: entries.length >= this.scanCap };
  }
}
