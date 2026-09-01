import { type Entry, EntryType, isExceptionType } from '../entry.js';
import { detectNPlusOne } from '../query/n_plus_one.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import {
  type CacheStats,
  type LatencyStats,
  percentile,
  type StatusBreakdown,
  summarizeStats,
} from './stats.js';
import { bucketTimeseries, type TimeseriesReport } from './timeseries.js';

/**
 * The Pulse feature — an aggregated "at a glance" health rollup over recorded
 * telescope entries. Ported from `nestjs-telescope`'s `pulse.service` +
 * `pulse-summary`, adapted to the Adonis entry model (a single-pass scan over
 * entries that already carry their `content`, N+1 grouped by `traceId` rather
 * than the NestJS `batchId`) and to REUSE the existing metrics primitives:
 * {@link summarizeStats} (request status + cache hit ratio + exception groups),
 * {@link bucketTimeseries} (throughput), {@link percentile} (slow-hotspot p99),
 * and {@link detectNPlusOne} (N+1 loops). Pure aggregation lives in
 * {@link summarizePulse}; {@link PulseService} adds the windowed store scan.
 */

const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_TOP_N = 5;
const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 500;
/** Threshold (ms) at/above which a latency sample counts as "slow". */
const DEFAULT_SLOW_MS = 100;
/**
 * Min p99 (ms) a route/outgoing family must reach to surface as a slow hotspot,
 * so a quiet, healthy host's fastest-of-the-slow route (e.g. `/health` at 18ms)
 * is not a false alarm. Matches the NestJS pulse default.
 */
const DEFAULT_SLOW_ROUTE_MS = 1000;
/** Min repetitions of one query template within a trace to flag an N+1 loop. */
const DEFAULT_NPLUSONE_THRESHOLD = 5;
/** Min samples a family needs before it can rank as a hotspot. */
const DEFAULT_HOTSPOT_MIN_COUNT = 1;
/** Safety cap on entries scanned per pulse; surfaced via `truncated`. */
const DEFAULT_SCAN_CAP = 50_000;

const MAX_LABEL_LENGTH = 500;

/** The togglable pulse cards. `counts` and the window meta are always present. */
export const PULSE_CARDS = [
  'throughput',
  'requests',
  'cache',
  'slowest',
  'slowRoutes',
  'slowOutgoing',
  'slowJobs',
  'exceptions',
  'nPlusOne',
  'loadByUser',
] as const;
export type PulseCardName = (typeof PULSE_CARDS)[number];

/** A single slow entry across all types, labelled from its content. */
export interface PulseSlowEntry {
  id: string;
  type: string;
  durationMs: number;
  label: string;
  traceId: string | null;
}

/** A grouped exception family (mirrors {@link summarizeStats}'s exception groups). */
export interface PulseExceptionGroup {
  key: string;
  class: string;
  message: string;
  count: number;
  /** ISO timestamp of the most recent occurrence in the window. */
  lastSeen: string;
}

/** A consistently-slow family (request route, outgoing target, or job), by p99. */
export interface PulseHotspot {
  /** The family label — the entry's `familyHash` (or a content-derived fallback). */
  route: string;
  count: number;
  p99: number;
  p50: number;
}

/** An N+1 query hotspot aggregated across traces. */
export interface PulseNPlusOne {
  familyHash: string;
  sql: string;
  /** Worst (max) repetition count of this family within a single trace. */
  perRequest: number;
  /** Number of distinct traces where this family tripped the threshold. */
  traces: number;
  /** Sum of repetition counts across those traces. */
  total: number;
  /** Total duration (ms) spent across all occurrences — the time "wasted" in the loop. */
  totalDurationMs: number;
  /** One trace id (the worst) to deep-link to. */
  sampleTraceId: string;
}

/** A user's share of the load in the window (from the `user:<id>` request tag). */
export interface PulseUserLoad {
  user: string;
  count: number;
  totalDurationMs: number;
}

/** Overall throughput over the window. */
export interface PulseThroughput {
  /** Entries recorded in the window. */
  total: number;
  /** Entries per minute across the window. */
  perMinute: number;
  /** Per-bucket throughput — reuses {@link bucketTimeseries}. */
  overTime: TimeseriesReport;
}

/** Request health: volume, error rate, HTTP status breakdown, and latency. */
export interface PulseRequestHealth {
  total: number;
  /** Share of requests that returned a 4xx or 5xx (`0`–`1`). */
  errorRate: number;
  status: StatusBreakdown;
  /** Present only when at least one request carried a `durationMs`. */
  latency?: LatencyStats;
}

/** The aggregated pulse rollup returned by {@link PulseService.getHealth}. */
export interface PulseSummary {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  /** Per-type entry counts over the window. */
  counts: Record<string, number>;
  throughput: PulseThroughput;
  requests: PulseRequestHealth;
  /** Present only when the `cache` card is enabled and cache entries exist. */
  cache?: CacheStats;
  slowest: PulseSlowEntry[];
  slowRoutes: PulseHotspot[];
  slowOutgoing: PulseHotspot[];
  slowJobs: PulseHotspot[];
  topExceptions: PulseExceptionGroup[];
  nPlusOne: PulseNPlusOne[];
  loadByUser: PulseUserLoad[];
  /** Entries scanned to build this summary. */
  scanned: number;
  /** Whether the scan hit its cap (results may be incomplete). */
  truncated: boolean;
}

/** Fully-resolved pulse options the pure aggregator acts on. */
export interface PulseOptions {
  topN: number;
  buckets: number;
  slowMs: number;
  slowRouteMs: number;
  hotspotMinCount: number;
  nPlusOneThreshold: number;
  cards: ReadonlySet<PulseCardName>;
}

function truncate(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH)}…` : value;
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** A human label for a slow entry, derived from its content by type. */
function labelFrom(entry: Entry): string {
  const record = asRecord(entry.content);
  if (record === null) return entry.familyHash ?? entry.type;
  if (typeof record.url === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
  }
  if (typeof record.sql === 'string') return record.sql;
  if (typeof record.queue === 'string' && typeof record.name === 'string') {
    return `${record.queue}:${record.name}`;
  }
  return entry.familyHash ?? entry.type;
}

/** The route family for a request entry: its `familyHash`, else `METHOD url`. */
function routeKey(entry: Entry): string | null {
  if (entry.familyHash !== null) return entry.familyHash;
  const record = asRecord(entry.content);
  if (record === null) return null;
  if (typeof record.url !== 'string') return null;
  return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
}

/** Extract the user id from a `user:<id>` tag, or `null` when none is present. */
function userFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('user:')) return tag.slice('user:'.length);
  }
  return null;
}

/** Rank per-family durations into hotspots by p99, gated by min-count (+ optional slow-ms). */
function toHotspots(
  durationsByFamily: Map<string, number[]>,
  options: PulseOptions,
  slowRouteMs: number,
): PulseHotspot[] {
  return [...durationsByFamily.entries()]
    .map(([route, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      return {
        route,
        count: sorted.length,
        p99: percentile(sorted, 0.99),
        p50: percentile(sorted, 0.5),
      };
    })
    .filter((h) => h.count >= options.hotspotMinCount && h.p99 >= slowRouteMs)
    .sort((a, b) => b.p99 - a.p99 || b.count - a.count || a.route.localeCompare(b.route))
    .slice(0, options.topN);
}

function pushDuration(map: Map<string, number[]>, key: string, durationMs: number): void {
  const existing = map.get(key);
  if (existing) existing.push(durationMs);
  else map.set(key, [durationMs]);
}

interface NPlusOneAccumulator {
  familyHash: string;
  sql: string;
  perRequest: number;
  traces: number;
  total: number;
  totalDurationMs: number;
  sampleTraceId: string;
}

/** Empty request-health card (used when the `requests` card is disabled). */
function emptyRequestHealth(): PulseRequestHealth {
  return {
    total: 0,
    errorRate: 0,
    status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
  };
}

/**
 * Aggregate a window of entries — each carrying its `content` — into a
 * {@link PulseSummary}. Pure: callers fetch the windowed entries and supply the
 * window bounds. Reuses {@link summarizeStats}, {@link bucketTimeseries},
 * {@link percentile}, and {@link detectNPlusOne} for the heavy lifting.
 */
export function summarizePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
  truncated = false,
): PulseSummary {
  const enabled = (card: PulseCardName): boolean => options.cards.has(card);
  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());

  const counts: Record<string, number> = {};
  const slowCandidates: Entry[] = [];
  const routeDurations = new Map<string, number[]>();
  const outgoingDurations = new Map<string, number[]>();
  const jobDurations = new Map<string, number[]>();
  const byTrace = new Map<string, Entry[]>();
  const userLoad = new Map<string, { count: number; totalDurationMs: number }>();
  const requestEntries: Entry[] = [];
  const cacheEntries: Entry[] = [];
  const exceptionEntries: Entry[] = [];

  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    if (typeof entry.durationMs === 'number') slowCandidates.push(entry);

    if (entry.type === EntryType.Request) {
      requestEntries.push(entry);
      const route = routeKey(entry);
      if (route !== null && typeof entry.durationMs === 'number') {
        pushDuration(routeDurations, route, entry.durationMs);
      }
      const user = userFromTags(entry.tags);
      if (user !== null) {
        const duration = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
        const existing = userLoad.get(user);
        if (existing) {
          existing.count += 1;
          existing.totalDurationMs += duration;
        } else {
          userLoad.set(user, { count: 1, totalDurationMs: duration });
        }
      }
    } else if (entry.type === EntryType.HttpClient) {
      if (entry.familyHash !== null && typeof entry.durationMs === 'number') {
        pushDuration(outgoingDurations, entry.familyHash, entry.durationMs);
      }
    } else if (entry.type === EntryType.Job) {
      if (entry.familyHash !== null && typeof entry.durationMs === 'number') {
        pushDuration(jobDurations, entry.familyHash, entry.durationMs);
      }
    } else if (entry.type === EntryType.Cache) {
      cacheEntries.push(entry);
    } else if (isExceptionType(entry.type)) {
      // Server `exception` AND browser `client_exception` — see EXCEPTION_ENTRY_TYPES.
      // Counting only the server one made a front-end outage invisible here while
      // the alert poller was already paging on it.
      exceptionEntries.push(entry);
    }

    if (entry.traceId !== null && entry.type === EntryType.Query) {
      const bucket = byTrace.get(entry.traceId);
      if (bucket) bucket.push(entry);
      else byTrace.set(entry.traceId, [entry]);
    }
  }

  // Throughput — reuse bucketTimeseries.
  const overTime = bucketTimeseries(entries, windowStart, windowEnd, options.buckets);
  const minutes = windowMs > 0 ? windowMs / 60_000 : 0;
  const throughput: PulseThroughput = enabled('throughput')
    ? {
        total: entries.length,
        perMinute: minutes > 0 ? entries.length / minutes : 0,
        overTime,
      }
    : { total: 0, perMinute: 0, overTime };

  // Request health — reuse summarizeStats for status + latency.
  let requests = emptyRequestHealth();
  if (enabled('requests')) {
    const stats = summarizeStats({
      entries: requestEntries,
      type: EntryType.Request,
      windowStart,
      windowEnd,
      windowMs,
      buckets: options.buckets,
      slowMs: options.slowMs,
      truncated,
    });
    const status = stats.status ?? emptyRequestHealth().status;
    const failed = status['4xx'] + status['5xx'];
    requests = {
      total: requestEntries.length,
      errorRate: requestEntries.length > 0 ? failed / requestEntries.length : 0,
      status,
      ...(stats.latency !== undefined ? { latency: stats.latency } : {}),
    };
  }

  // Cache hit ratio — reuse summarizeStats' cache aggregate.
  let cache: CacheStats | undefined;
  if (enabled('cache') && cacheEntries.length > 0) {
    const stats = summarizeStats({
      entries: cacheEntries,
      type: EntryType.Cache,
      windowStart,
      windowEnd,
      windowMs,
      buckets: options.buckets,
      slowMs: options.slowMs,
      truncated,
    });
    cache = stats.cache;
  }

  // Top exceptions — reuse summarizeStats' exception grouping.
  let topExceptions: PulseExceptionGroup[] = [];
  if (enabled('exceptions') && exceptionEntries.length > 0) {
    const stats = summarizeStats({
      entries: exceptionEntries,
      type: EntryType.Exception,
      windowStart,
      windowEnd,
      windowMs,
      buckets: options.buckets,
      slowMs: options.slowMs,
      truncated,
      topExceptions: options.topN,
    });
    topExceptions = (stats.exceptions ?? []).map((group) => ({
      key: group.key,
      class: group.class,
      message: group.message,
      count: group.count,
      lastSeen: group.lastAt.toISOString(),
    }));
  }

  // Slowest entries across all types.
  const slowest: PulseSlowEntry[] = enabled('slowest')
    ? slowCandidates
        .slice()
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.id.localeCompare(b.id))
        .slice(0, options.topN)
        .map((entry) => ({
          id: entry.id,
          type: entry.type,
          durationMs: entry.durationMs as number,
          label: truncate(labelFrom(entry)),
          traceId: entry.traceId,
        }))
    : [];

  // Slow hotspots — reuse percentile via toHotspots.
  const slowRoutes = enabled('slowRoutes')
    ? toHotspots(routeDurations, options, options.slowRouteMs)
    : [];
  const slowOutgoing = enabled('slowOutgoing')
    ? toHotspots(outgoingDurations, options, options.slowRouteMs)
    : [];
  // Jobs are not gated by the slow-ms threshold — the slowest jobs always matter.
  const slowJobs = enabled('slowJobs') ? toHotspots(jobDurations, options, 0) : [];

  // N+1 hotspots — reuse detectNPlusOne per trace, aggregated across traces.
  let nPlusOne: PulseNPlusOne[] = [];
  if (enabled('nPlusOne')) {
    const hotspots = new Map<string, NPlusOneAccumulator>();
    const familyDurationInTrace = new Map<string, number>();
    for (const [traceId, traceEntries] of byTrace) {
      familyDurationInTrace.clear();
      for (const entry of traceEntries) {
        if (entry.familyHash !== null && typeof entry.durationMs === 'number') {
          familyDurationInTrace.set(
            entry.familyHash,
            (familyDurationInTrace.get(entry.familyHash) ?? 0) + entry.durationMs,
          );
        }
      }
      for (const insight of detectNPlusOne(traceEntries, options.nPlusOneThreshold)) {
        const loopDuration = familyDurationInTrace.get(insight.familyHash) ?? 0;
        const existing = hotspots.get(insight.familyHash);
        if (existing) {
          existing.traces += 1;
          existing.total += insight.count;
          existing.totalDurationMs += loopDuration;
          if (insight.count > existing.perRequest) {
            existing.perRequest = insight.count;
            existing.sampleTraceId = traceId;
          }
        } else {
          hotspots.set(insight.familyHash, {
            familyHash: insight.familyHash,
            sql: insight.sql,
            perRequest: insight.count,
            traces: 1,
            total: insight.count,
            totalDurationMs: loopDuration,
            sampleTraceId: traceId,
          });
        }
      }
    }
    nPlusOne = [...hotspots.values()]
      .sort(
        (a, b) =>
          b.totalDurationMs - a.totalDurationMs ||
          b.total - a.total ||
          b.traces - a.traces ||
          a.familyHash.localeCompare(b.familyHash),
      )
      .slice(0, options.topN)
      .map((h) => ({
        familyHash: h.familyHash,
        sql: truncate(h.sql),
        perRequest: h.perRequest,
        traces: h.traces,
        total: h.total,
        totalDurationMs: h.totalDurationMs,
        sampleTraceId: h.sampleTraceId,
      }));
  }

  // Load by user — top users by total request time.
  const loadByUser: PulseUserLoad[] = enabled('loadByUser')
    ? [...userLoad.entries()]
        .map(([user, load]) => ({ user, count: load.count, totalDurationMs: load.totalDurationMs }))
        .sort(
          (a, b) =>
            b.totalDurationMs - a.totalDurationMs ||
            b.count - a.count ||
            a.user.localeCompare(b.user),
        )
        .slice(0, options.topN)
    : [];

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs,
    counts,
    throughput,
    requests,
    ...(cache !== undefined ? { cache } : {}),
    slowest,
    slowRoutes,
    slowOutgoing,
    slowJobs,
    topExceptions,
    nPlusOne,
    loadByUser,
    scanned: entries.length,
    truncated,
  };
}

/** Per-call / per-instance pulse tuning (all optional; sensible defaults). */
export interface PulseServiceOptions {
  /** Trailing window (ms) the summary aggregates over. Default 3_600_000 (1h). */
  windowMs?: number;
  /** How many rows each top-N list returns. Default 5. */
  topN?: number;
  /** Throughput/over-time bucket count. Default 60 (clamped 1–500). */
  buckets?: number;
  /** Latency "slow" threshold (ms). Default 100. */
  slowMs?: number;
  /** Min p99 (ms) for a route/outgoing family to count as a hotspot. Default 1000. */
  slowRouteMs?: number;
  /** Min samples a family needs to rank as a hotspot. Default 1. */
  hotspotMinCount?: number;
  /** Min repetitions of one query template within a trace to flag N+1. Default 5. */
  nPlusOneThreshold?: number;
  /** Which cards to compute. Omit for all. */
  cards?: readonly PulseCardName[];
  /** Safety cap on entries scanned per pulse. Default 50000. */
  scanCap?: number;
}

/** A per-call override of the window (and, optionally, top-N). */
export interface PulseQuery {
  windowMs?: number;
  topN?: number;
}

/**
 * Read-only Pulse rollup over a {@link TelescopeStore}. Storage-agnostic — it
 * reads the store (the source of truth) on demand through the newest-first
 * {@link TelescopeStore.list} contract, never a specific provider, and never a
 * live counter. Analysis reads ALREADY-redacted stored entries, so redaction is
 * never bypassed. Idiomatic Adonis: a plain class, no DI decorators (constructed
 * by the provider / {@link TelescopeService}, exactly like {@link import('./metrics_service.js').MetricsService}).
 */
export class PulseService {
  private readonly windowMs: number;
  private readonly scanCap: number;
  private readonly base: Omit<PulseOptions, 'cards'> & { cards: ReadonlySet<PulseCardName> };

  constructor(
    private readonly store: TelescopeStore,
    options: PulseServiceOptions = {},
  ) {
    this.windowMs = positiveOr(options.windowMs, DEFAULT_WINDOW_MS);
    this.scanCap = positiveOr(options.scanCap, DEFAULT_SCAN_CAP);
    this.base = {
      topN: positiveOr(options.topN, DEFAULT_TOP_N),
      buckets: clampBuckets(options.buckets),
      slowMs: options.slowMs ?? DEFAULT_SLOW_MS,
      slowRouteMs: options.slowRouteMs ?? DEFAULT_SLOW_ROUTE_MS,
      hotspotMinCount: options.hotspotMinCount ?? DEFAULT_HOTSPOT_MIN_COUNT,
      nPlusOneThreshold: positiveOr(options.nPlusOneThreshold, DEFAULT_NPLUSONE_THRESHOLD),
      cards: options.cards ? new Set(options.cards) : new Set(PULSE_CARDS),
    };
  }

  /**
   * Build the health snapshot over the trailing window. `query.windowMs` /
   * `query.topN` override the configured defaults for a single call.
   */
  async getHealth(query: PulseQuery = {}): Promise<PulseSummary> {
    const windowMs = query.windowMs ?? this.windowMs;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const listQuery: EntryQuery = { after: windowStart, limit: this.scanCap };
    const entries = await this.store.list(listQuery);
    const truncated = entries.length >= this.scanCap;

    const options: PulseOptions = {
      ...this.base,
      topN: query.topN ?? this.base.topN,
    };
    return summarizePulse(entries, windowStart, windowEnd, options, truncated);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampBuckets(buckets: number | undefined): number {
  return Math.min(MAX_BUCKETS, Math.max(1, Math.floor(buckets ?? DEFAULT_BUCKETS)));
}
