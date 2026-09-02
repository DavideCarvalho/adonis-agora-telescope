import { type Entry, EntryType, EXCEPTION_ENTRY_TYPES, isExceptionType } from '../entry.js';
import {
  detectNPlusOne,
  detectNPlusOnePatterns,
  type NPlusOneInsight,
  type NPlusOnePattern,
} from '../query/n_plus_one.js';
import type { RequestKind } from '../request_watcher.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import { type ScreenStats, summarizeScreens } from './screens.js';
import { estimateLatencyPercentiles, type StatsResult, summarizeStats } from './stats.js';
import {
  bucketTimeseries,
  bucketTimeseriesFromCounts,
  type TimeseriesReport,
} from './timeseries.js';
import { summarizeTraces, type TraceSummary } from './traces.js';
import { buildWaterfall, type Waterfall } from './waterfall.js';

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
  /**
   * How many exception groups to return. The default (8) is a dashboard-card
   * default: it is right for the Overview tile and wrong for the Exceptions screen,
   * where capping at 8 means the 9th most common exception is not merely
   * out-of-sight, it is unreachable. That screen asks for more.
   */
  topExceptions?: number;
}

export interface ScreensQuery {
  windowMs: number;
  /** Only page visits, only API calls, or only assets. Omit for all. */
  kind?: RequestKind;
  limit?: number;
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

    const { entries, truncated } = await this.collectForStats(query.type, windowStart);

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
      ...(query.topExceptions !== undefined ? { topExceptions: query.topExceptions } : {}),
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
    // Fast path: the chart needs only `createdAt` and `type`, and a store that can
    // count per bucket gives us exactly that — instead of `select('*')` shipping every
    // entry's `content` blob out of the database so we can throw it away.
    if (typeof this.store.countByBucket === 'function') {
      const spanMs = Math.max(1, windowEnd.getTime() - windowStart.getTime());
      const rows = await this.store.countByBucket({
        after: windowStart,
        before: windowEnd,
        bucketMs: Math.max(1, Math.floor(spanMs / Math.max(1, buckets))),
        ...(query.type !== undefined ? { type: query.type } : {}),
      });
      return bucketTimeseriesFromCounts(rows, windowStart, windowEnd, buckets);
    }

    const { entries } = await this.collect({
      after: windowStart,
      ...(query.type !== undefined ? { type: query.type } : {}),
    });
    return bucketTimeseries(entries, windowStart, windowEnd, buckets);
  }

  /**
   * Recent traces, newest-last-seen first, one page at a time.
   *
   * The store picks the page of trace ids (an indexed `GROUP BY` when it can — see
   * {@link TelescopeStore.listTraceIds}) and only THEN do we fetch the entries of
   * those traces. That ordering is the whole point: grouping first meant reading up
   * to `scanCap` entries to answer a request for 50 traces, and on a busy table the
   * chattiest watcher filled that budget before the interesting traces were reached
   * — the screen was both slow AND incomplete.
   *
   * A store without the capability falls back to scan-and-group, which is what this
   * method always used to do.
   */
  async getTraces(limit = 50, offset = 0): Promise<TraceSummary[]> {
    const page = Math.max(0, Math.floor(limit));
    const skip = Math.max(0, Math.floor(offset));

    if (typeof this.store.listTraceIds !== 'function') {
      const { entries } = await this.collect({});
      return summarizeTraces(entries, { limit: page + skip }).slice(skip);
    }

    const rows = await this.store.listTraceIds({ limit: page, offset: skip });
    if (rows.length === 0) return [];

    const entries = await this.store.list({
      traceIds: rows.map((row) => row.traceId),
      limit: this.scanCap,
    });
    // summarizeTraces re-derives the ordering from the entries it is given, so the
    // page order survives without the store and the summarizer having to agree on it.
    return summarizeTraces(entries, { limit: page });
  }

  /**
   * Per-route traffic over a window — what the "screens" view is built on.
   *
   * Windowed and type-filtered at the store, so this reads `request` entries only
   * rather than the whole table.
   */
  async getScreens(query: ScreensQuery): Promise<ScreenStats[]> {
    const windowStart = new Date(Date.now() - query.windowMs);
    const { entries } = await this.collect({ type: EntryType.Request, after: windowStart });
    return summarizeScreens(entries, {
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
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

  /**
   * Entries for a stats window. Asking for an EXCEPTION type collects both
   * `exception` and `client_exception`: a browser-reported error is an error, and
   * scoping to one while silently dropping the other is what left the dashboard's
   * exception view empty during a front-end-only incident — while the alert poller,
   * which has always read both, was paging on it.
   *
   * One `list` per type (rather than a multi-type query) because `EntryQuery.type`
   * is a single value in the store contract; this mirrors what the alert poller
   * already does with {@link EXCEPTION_ENTRY_TYPES}. `truncated` is sticky: if
   * EITHER scan hit the cap the window is incomplete.
   */
  private async collectForStats(
    type: string,
    after: Date,
  ): Promise<{ entries: Entry[]; truncated: boolean }> {
    if (!isExceptionType(type)) return this.collect({ type, after });

    const results = await Promise.all(
      EXCEPTION_ENTRY_TYPES.map((exceptionType) => this.collect({ type: exceptionType, after })),
    );
    return {
      entries: results.flatMap((result) => result.entries),
      truncated: results.some((result) => result.truncated),
    };
  }
}
