import { type Entry, EntryType, EXCEPTION_ENTRY_TYPES, isExceptionType } from '../entry.js';
import type { DurationRow, TelescopeStore, TraceRepeatRow } from '../store.js';
import {
  type CacheStats,
  type LatencyStats,
  percentile,
  type StatusBreakdown,
  summarizeStats,
} from './stats.js';
import {
  bucketTimeseries,
  bucketTimeseriesFromCounts,
  type TimeseriesReport,
} from './timeseries.js';

/**
 * The Pulse feature — an aggregated "at a glance" health rollup over recorded
 * telescope entries. Ported from `nestjs-telescope`'s `pulse.service` +
 * `pulse-summary`, adapted to the Adonis entry model (a single-pass scan over
 * entries that already carry their `content`, N+1 grouped by `traceId` rather
 * than the NestJS `batchId`) and to REUSE the existing metrics primitives:
 * {@link summarizeStats} (request status + cache hit ratio + exception groups),
 * {@link bucketTimeseries} (throughput) and {@link percentile} (slow-hotspot p99);
 * N+1 loops are query families repeated within one trace. Pure aggregation lives in
 * {@link summarizePulse}; {@link PulseService} adds the windowed store reads.
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
  /** The entry type of the group — `exception` (server) or `client_exception` (browser). */
  type: string;
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

/** Where a {@link PulseSlowWork} row was measured. */
export type PulseSlowWorkSource = 'queue' | 'durable';

/**
 * A kind of background work that ran in the window, with how long it took: a queue job (the
 * `queue` watcher's `job` entries, by `queue:name`) or a durable workflow step (the `durable`
 * diagnostics entries of `@adonis-agora/durable`, by step name).
 */
export interface PulseSlowWork {
  source: PulseSlowWorkSource;
  /** The job (`queue:name`) or the durable step name; `''` for durable steps recorded unnamed. */
  name: string;
  /** Executions that finished in the window. */
  count: number;
  /** How many of them failed (a durable `step.failed`, a job tagged `failed`). */
  failures: number;
  p50: number;
  p95: number;
  max: number;
}

/** The family prefix of the timed durable step entries (`durable:step.completed:<name>`). */
export const DURABLE_STEP_FAMILY_PREFIX = 'durable:step.';

const DURABLE_STEP_FAMILY = /^durable:step\.(completed|failed)(?::(.*))?$/s;

/**
 * The step name and outcome of a durable step entry's family: `durable:step.completed:<name>`
 * (`@adonis-agora/durable` 1.0.0-rc.X+), or `durable:step.completed` from an older recorder,
 * whose steps all share the name `''`. `null` for any other family.
 */
export function durableStepOf(familyHash: string): { name: string; failed: boolean } | null {
  const match = DURABLE_STEP_FAMILY.exec(familyHash);
  if (match === null) return null;
  return { name: match[2] ?? '', failed: match[1] === 'failed' };
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
  /** Queue jobs only (by p99); {@link slowWork} has them with the durable steps. */
  slowJobs: PulseHotspot[];
  /**
   * The slowest background work of the window, by p95: queue jobs and durable workflow steps
   * together, each labelled with its source. Computed with the `slowJobs` card.
   */
  slowWork: PulseSlowWork[];
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
  perRequest: number;
  traces: number;
  total: number;
  totalDurationMs: number;
  sampleTraceId: string;
  /** Newest occurrence of the family in {@link sampleTraceId}, the tie-break between equally bad traces. */
  sampleLastAt: number;
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
 * What every pulse card is computed from. A store with the aggregate fast paths fills it
 * from a few targeted reads ({@link PulseService}); without them it comes from one scan
 * of the window ({@link inputsFromEntries}). Both feed the same {@link draftPulse}, so the
 * summary does not depend on which store answered.
 */
interface PulseInputs {
  /** Entries per type in the window. */
  counts: Record<string, number>;
  /** Entries in the window. */
  total: number;
  overTime: TimeseriesReport;
  /** Request entries; their content needs `method`, `url` and `status` only. */
  requests: Entry[];
  /** Cache entries; their content needs `operation` and `key` only. */
  cache: Entry[];
  /** Exception entries (server and client); their content needs `name` and `message` only. */
  exceptions: Entry[];
  /** Outgoing HTTP entries; content unused. */
  httpClient: Entry[];
  /** Job entries; content unused. */
  jobs: Entry[];
  /** The timed durable step entries (family + duration only). */
  durableSteps: DurationRow[];
  /** The slowest entries, slowest first, at most `topN`; content unused. */
  slowest: Entry[];
  /** Query families repeated within one trace at least `nPlusOneThreshold` times. */
  repeats: TraceRepeatRow[];
  truncated: boolean;
}

/** Slowest first, ties by id: the order {@link PulseSummary.slowest} lists entries in. */
function bySlowest(a: Entry, b: Entry): number {
  return (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.id.localeCompare(b.id);
}

/** Build the {@link PulseInputs} from every entry of the window. */
function inputsFromEntries(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
  truncated: boolean,
): PulseInputs {
  const counts: Record<string, number> = {};
  const requests: Entry[] = [];
  const cache: Entry[] = [];
  const exceptions: Entry[] = [];
  const httpClient: Entry[] = [];
  const jobs: Entry[] = [];
  const durableSteps: DurationRow[] = [];
  const timed: Entry[] = [];
  const repeats = new Map<string, TraceRepeatRow>();

  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    if (typeof entry.durationMs === 'number') timed.push(entry);
    if (entry.type === EntryType.Request) requests.push(entry);
    else if (entry.type === EntryType.HttpClient) httpClient.push(entry);
    else if (entry.type === EntryType.Job) jobs.push(entry);
    else if (
      entry.type === EntryType.Diagnostic &&
      typeof entry.durationMs === 'number' &&
      entry.familyHash?.startsWith(DURABLE_STEP_FAMILY_PREFIX) === true
    ) {
      durableSteps.push({ familyHash: entry.familyHash, durationMs: entry.durationMs });
    } else if (entry.type === EntryType.Cache) cache.push(entry);
    // Server `exception` AND browser `client_exception` — see EXCEPTION_ENTRY_TYPES.
    // Counting only the server one made a front-end outage invisible here while
    // the alert poller was already paging on it.
    else if (isExceptionType(entry.type)) exceptions.push(entry);

    if (entry.type === EntryType.Query && entry.traceId !== null && entry.familyHash !== null) {
      const key = `${entry.traceId}\u0000${entry.familyHash}`;
      const createdAt = entry.createdAt.getTime();
      const duration = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
      const seen = repeats.get(key);
      if (seen === undefined) {
        repeats.set(key, {
          traceId: entry.traceId,
          familyHash: entry.familyHash,
          count: 1,
          totalDurationMs: duration,
          lastAt: createdAt,
        });
      } else {
        seen.count += 1;
        seen.totalDurationMs += duration;
        if (createdAt > seen.lastAt) seen.lastAt = createdAt;
      }
    }
  }

  return {
    counts,
    total: entries.length,
    overTime: bucketTimeseries(entries, windowStart, windowEnd, options.buckets),
    requests,
    cache,
    exceptions,
    httpClient,
    jobs,
    durableSteps,
    slowest: timed.sort(bySlowest).slice(0, options.topN),
    repeats: [...repeats.values()].filter((r) => r.count >= options.nPlusOneThreshold),
    truncated,
  };
}

/**
 * Aggregate a window of entries — each carrying its `content` — into a
 * {@link PulseSummary}. Pure: callers fetch the windowed entries and supply the
 * window bounds. Reuses {@link summarizeStats}, {@link bucketTimeseries} and
 * {@link percentile} for the heavy lifting.
 */
export function summarizePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
  truncated = false,
): PulseSummary {
  const draft = draftPulse(inputsFromEntries(entries, windowStart, windowEnd, options, truncated), {
    windowStart,
    windowEnd,
    options,
  });
  return finishPulse(
    draft,
    (entry) => entry,
    (traceId, familyHash) => newestOf(entries, traceId, familyHash),
  );
}

/** The newest entry of `familyHash` in `traceId` (the one an N+1 hotspot shows the SQL of). */
function newestOf(entries: Entry[], traceId: string, familyHash: string): Entry | null {
  let newest: Entry | null = null;
  for (const entry of entries) {
    if (entry.traceId !== traceId || entry.familyHash !== familyHash) continue;
    if (
      newest === null ||
      entry.createdAt.getTime() > newest.createdAt.getTime() ||
      (entry.createdAt.getTime() === newest.createdAt.getTime() && entry.sequence > newest.sequence)
    ) {
      newest = entry;
    }
  }
  return newest;
}

/**
 * A pulse summary short of the two lists labelled from content: the slowest entries
 * and the N+1 hotspots' SQL. Everything else reads at most a few content fields of
 * request, cache and exception entries, so the content of the few entries these two
 * lists show is fetched afterwards.
 */
interface PulseDraft {
  summary: Omit<PulseSummary, 'slowest' | 'nPlusOne'>;
  slowest: Entry[];
  nPlusOne: NPlusOneAccumulator[];
}

/**
 * Label the draft's slowest entries (through `withContent`) and N+1 hotspots (with the
 * SQL of `sampleOf(sampleTraceId, familyHash)`).
 */
function finishPulse(
  draft: PulseDraft,
  withContent: (entry: Entry) => Entry,
  sampleOf: (traceId: string, familyHash: string) => Entry | null | undefined,
): PulseSummary {
  const { summary } = draft;
  return {
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
    windowMs: summary.windowMs,
    counts: summary.counts,
    throughput: summary.throughput,
    requests: summary.requests,
    ...(summary.cache !== undefined ? { cache: summary.cache } : {}),
    slowest: draft.slowest.map((entry) => ({
      id: entry.id,
      type: entry.type,
      durationMs: entry.durationMs as number,
      label: truncate(labelFrom(withContent(entry))),
      traceId: entry.traceId,
    })),
    slowRoutes: summary.slowRoutes,
    slowOutgoing: summary.slowOutgoing,
    slowJobs: summary.slowJobs,
    slowWork: summary.slowWork,
    topExceptions: summary.topExceptions,
    nPlusOne: draft.nPlusOne.map((h) => {
      const sample = sampleOf(h.sampleTraceId, h.familyHash);
      return {
        familyHash: h.familyHash,
        sql: truncate(sample ? sqlOf(sample) : ''),
        perRequest: h.perRequest,
        traces: h.traces,
        total: h.total,
        totalDurationMs: h.totalDurationMs,
        sampleTraceId: h.sampleTraceId,
      };
    }),
    loadByUser: summary.loadByUser,
    scanned: summary.scanned,
    truncated: summary.truncated,
  };
}

/** The SQL of a query entry, or `''`. */
function sqlOf(entry: Entry): string {
  const record = asRecord(entry.content);
  return record !== null && typeof record.sql === 'string' ? record.sql : '';
}

/** Rank the N+1 hotspots from per-trace repeats: worst total time wasted first. */
function nPlusOneOf(repeats: TraceRepeatRow[], topN: number): NPlusOneAccumulator[] {
  const hotspots = new Map<string, NPlusOneAccumulator>();
  for (const repeat of repeats) {
    const existing = hotspots.get(repeat.familyHash);
    if (existing === undefined) {
      hotspots.set(repeat.familyHash, {
        familyHash: repeat.familyHash,
        perRequest: repeat.count,
        traces: 1,
        total: repeat.count,
        totalDurationMs: repeat.totalDurationMs,
        sampleTraceId: repeat.traceId,
        sampleLastAt: repeat.lastAt,
      });
      continue;
    }
    existing.traces += 1;
    existing.total += repeat.count;
    existing.totalDurationMs += repeat.totalDurationMs;
    // The worst trace; between equally bad ones the most recent, then the lowest id, so the
    // pick does not depend on the order the repeats arrive in.
    const worse =
      repeat.count > existing.perRequest ||
      (repeat.count === existing.perRequest &&
        (repeat.lastAt > existing.sampleLastAt ||
          (repeat.lastAt === existing.sampleLastAt && repeat.traceId < existing.sampleTraceId)));
    if (worse) {
      existing.perRequest = repeat.count;
      existing.sampleTraceId = repeat.traceId;
      existing.sampleLastAt = repeat.lastAt;
    }
  }
  return [...hotspots.values()]
    .sort(
      (a, b) =>
        b.totalDurationMs - a.totalDurationMs ||
        b.total - a.total ||
        b.traces - a.traces ||
        a.familyHash.localeCompare(b.familyHash),
    )
    .slice(0, topN);
}

function draftPulse(
  inputs: PulseInputs,
  window: { windowStart: Date; windowEnd: Date; options: PulseOptions },
): PulseDraft {
  const { windowStart, windowEnd, options } = window;
  const { truncated } = inputs;
  const enabled = (card: PulseCardName): boolean => options.cards.has(card);
  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());

  const routeDurations = new Map<string, number[]>();
  const userLoad = new Map<string, { count: number; totalDurationMs: number }>();
  for (const entry of inputs.requests) {
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
  }
  const outgoingDurations = familyDurations(inputs.httpClient);
  const jobDurations = familyDurations(inputs.jobs);

  // Throughput — the bucketed counts.
  const minutes = windowMs > 0 ? windowMs / 60_000 : 0;
  const throughput: PulseThroughput = enabled('throughput')
    ? {
        total: inputs.total,
        perMinute: minutes > 0 ? inputs.total / minutes : 0,
        overTime: inputs.overTime,
      }
    : { total: 0, perMinute: 0, overTime: inputs.overTime };

  // Request health — reuse summarizeStats for status + latency.
  let requests = emptyRequestHealth();
  if (enabled('requests')) {
    const stats = summarizeStats({
      entries: inputs.requests,
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
    const total = inputs.requests.length;
    requests = {
      total,
      errorRate: total > 0 ? failed / total : 0,
      status,
      ...(stats.latency !== undefined ? { latency: stats.latency } : {}),
    };
  }

  // Cache hit ratio — reuse summarizeStats' cache aggregate.
  let cache: CacheStats | undefined;
  if (enabled('cache') && inputs.cache.length > 0) {
    const stats = summarizeStats({
      entries: inputs.cache,
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
  if (enabled('exceptions') && inputs.exceptions.length > 0) {
    const stats = summarizeStats({
      entries: inputs.exceptions,
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
      type: group.type,
      class: group.class,
      message: group.message,
      count: group.count,
      lastSeen: group.lastAt.toISOString(),
    }));
  }

  // Slow hotspots — reuse percentile via toHotspots.
  const slowRoutes = enabled('slowRoutes')
    ? toHotspots(routeDurations, options, options.slowRouteMs)
    : [];
  const slowOutgoing = enabled('slowOutgoing')
    ? toHotspots(outgoingDurations, options, options.slowRouteMs)
    : [];
  // Jobs are not gated by the slow-ms threshold — the slowest jobs always matter.
  const slowJobs = enabled('slowJobs') ? toHotspots(jobDurations, options, 0) : [];
  const slowWork = enabled('slowJobs')
    ? rankSlowWork(inputs.jobs, inputs.durableSteps, options.topN)
    : [];

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
    summary: {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      windowMs,
      counts: inputs.counts,
      throughput,
      requests,
      ...(cache !== undefined ? { cache } : {}),
      slowRoutes,
      slowOutgoing,
      slowJobs,
      slowWork,
      topExceptions,
      loadByUser,
      scanned: inputs.total,
      truncated,
    },
    slowest: enabled('slowest') ? inputs.slowest.slice(0, options.topN) : [],
    nPlusOne: enabled('nPlusOne') ? nPlusOneOf(inputs.repeats, options.topN) : [],
  };
}

/** Accumulates one {@link PulseSlowWork} row. */
interface SlowWorkAccumulator {
  source: PulseSlowWorkSource;
  name: string;
  durations: number[];
  failures: number;
}

/**
 * The slowest kinds of background work, by p95 (then max, then executions): queue jobs grouped by
 * family, durable steps by name (completions and failures together). Not gated by a slow
 * threshold: the slowest background work always matters.
 */
export function rankSlowWork(
  jobs: readonly Entry[],
  durableSteps: readonly DurationRow[],
  topN: number,
): PulseSlowWork[] {
  const groups = new Map<string, SlowWorkAccumulator>();
  const add = (source: PulseSlowWorkSource, name: string, durationMs: number, failed: boolean) => {
    const key = `${source}\u0000${name}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { source, name, durations: [], failures: 0 };
      groups.set(key, group);
    }
    group.durations.push(durationMs);
    if (failed) group.failures += 1;
  };
  for (const job of jobs) {
    if (job.familyHash === null || typeof job.durationMs !== 'number') continue;
    add('queue', job.familyHash, job.durationMs, job.tags.includes('failed'));
  }
  for (const row of durableSteps) {
    const step = durableStepOf(row.familyHash);
    if (step !== null) add('durable', step.name, row.durationMs, step.failed);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = group.durations.sort((a, b) => a - b);
      return {
        source: group.source,
        name: truncate(group.name),
        count: sorted.length,
        failures: group.failures,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.p95 - a.p95 ||
        b.max - a.max ||
        b.count - a.count ||
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(0, topN));
}

/** Durations per `familyHash` (entries with both), for a hotspot card. */
function familyDurations(entries: Entry[]): Map<string, number[]> {
  const byFamily = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.familyHash !== null && typeof entry.durationMs === 'number') {
      pushDuration(byFamily, entry.familyHash, entry.durationMs);
    }
  }
  return byFamily;
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
  /**
   * Only these cards (of the configured ones): a page that shows a few of them skips the reads
   * the others need. Unknown names are ignored; none left means every configured card.
   */
  cards?: readonly string[];
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
   *
   * A store with the aggregate fast paths ({@link TelescopeStore.countByBucket},
   * {@link TelescopeStore.listSlowest}, {@link TelescopeStore.countTraceRepeats}) answers
   * with a few targeted reads covering the whole window; any other store is scanned (up to
   * `scanCap` entries, newest first, `truncated` past it). Both give the same summary.
   */
  async getHealth(query: PulseQuery = {}): Promise<PulseSummary> {
    const windowMs = query.windowMs ?? this.windowMs;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const options: PulseOptions = {
      ...this.base,
      topN: query.topN ?? this.base.topN,
      cards: narrowCards(this.base.cards, query.cards),
    };

    const inputs = hasPulseFastPaths(this.store)
      ? await this.readInputs(this.store, windowStart, windowEnd, options)
      : await this.scanInputs(windowStart, windowEnd, options);
    const draft = draftPulse(inputs, { windowStart, windowEnd, options });
    const [slowest, samples] = await Promise.all([
      this.withContentById(draft.slowest),
      this.nPlusOneSamples(draft.nPlusOne, windowStart, windowEnd),
    ]);
    return finishPulse(
      draft,
      (entry) => slowest.get(entry.id) ?? entry,
      (traceId, familyHash) => samples.get(`${traceId}\u0000${familyHash}`),
    );
  }

  /** The inputs from the store's aggregate reads: nothing but their results leaves the database. */
  private async readInputs(
    store: TelescopeStore & Required<Pick<TelescopeStore, PulseFastPath>>,
    windowStart: Date,
    windowEnd: Date,
    options: PulseOptions,
  ): Promise<PulseInputs> {
    const cards = options.cards;
    const window = { after: windowStart, before: windowEnd };
    // `list` takes an exclusive `before`; the aggregates an inclusive one.
    const listWindow = { after: windowStart, before: new Date(windowEnd.getTime() + 1) };
    const spanMs = Math.max(1, windowEnd.getTime() - windowStart.getTime());
    const listOf = (type: string, fields: string[] | null): Promise<Entry[]> =>
      store.list({
        ...listWindow,
        type,
        size: this.scanCap,
        ...(fields === null ? { omitContent: true } : { contentFields: fields }),
      });
    const none = Promise.resolve([] as Entry[]);
    const needsRequests =
      cards.has('requests') || cards.has('slowRoutes') || cards.has('loadByUser');

    const [buckets, slowest, repeats, requests, cache, exceptions, httpClient, jobs, durableSteps] =
      await Promise.all([
        store.countByBucket({
          ...window,
          bucketMs: Math.max(1, Math.floor(spanMs / options.buckets)),
        }),
        cards.has('slowest') ? store.listSlowest({ ...window, limit: options.topN }) : none,
        cards.has('nPlusOne')
          ? store.countTraceRepeats({
              ...window,
              type: EntryType.Query,
              minCount: options.nPlusOneThreshold,
            })
          : Promise.resolve([] as TraceRepeatRow[]),
        needsRequests ? listOf(EntryType.Request, ['method', 'url', 'status']) : none,
        cards.has('cache') ? listOf(EntryType.Cache, ['operation', 'key']) : none,
        cards.has('exceptions')
          ? Promise.all(EXCEPTION_ENTRY_TYPES.map((type) => listOf(type, ['name', 'message'])))
          : Promise.resolve([] as Entry[][]),
        cards.has('slowOutgoing') ? listOf(EntryType.HttpClient, null) : none,
        cards.has('slowJobs') ? listOf(EntryType.Job, null) : none,
        cards.has('slowJobs')
          ? this.durableStepDurations(store, windowStart, windowEnd)
          : Promise.resolve([] as DurationRow[]),
      ]);

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of buckets) {
      counts[row.type] = (counts[row.type] ?? 0) + row.count;
      total += row.count;
    }
    const lists = [requests, cache, httpClient, jobs, ...exceptions];
    return {
      counts,
      total,
      overTime: bucketTimeseriesFromCounts(buckets, windowStart, windowEnd, options.buckets),
      requests,
      cache,
      exceptions: exceptions.flat(),
      httpClient,
      jobs,
      durableSteps,
      slowest,
      repeats,
      truncated:
        lists.some((list) => list.length >= this.scanCap) || durableSteps.length >= this.scanCap,
    };
  }

  /**
   * The family and duration of the window's timed durable steps: from the store's
   * {@link TelescopeStore.listDurations} (an index read, no row content), else from the window's
   * diagnostic entries listed without content.
   */
  private async durableStepDurations(
    store: TelescopeStore,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<DurationRow[]> {
    if (typeof store.listDurations === 'function') {
      return store.listDurations({
        after: windowStart,
        before: windowEnd,
        type: EntryType.Diagnostic,
        familyPrefixes: [DURABLE_STEP_FAMILY_PREFIX],
        limit: this.scanCap,
      });
    }
    const entries = await store.list({
      type: EntryType.Diagnostic,
      after: windowStart,
      before: new Date(windowEnd.getTime() + 1),
      size: this.scanCap,
      omitContent: true,
    });
    const rows: DurationRow[] = [];
    for (const entry of entries) {
      if (
        typeof entry.durationMs === 'number' &&
        entry.familyHash?.startsWith(DURABLE_STEP_FAMILY_PREFIX) === true
      ) {
        rows.push({ familyHash: entry.familyHash, durationMs: entry.durationMs });
      }
    }
    return rows;
  }

  /**
   * The inputs from one scan of the window: the newest `scanCap` entries, without content,
   * plus the content of the types the cards read it from.
   */
  private async scanInputs(
    windowStart: Date,
    windowEnd: Date,
    options: PulseOptions,
  ): Promise<PulseInputs> {
    const before = new Date(windowEnd.getTime() + 1);
    const scanned = await this.store.list({
      after: windowStart,
      before,
      size: this.scanCap,
      omitContent: true,
    });
    const truncated = scanned.length >= this.scanCap;
    const entries = await this.withContentFor(
      scanned,
      contentTypes(options.cards),
      windowStart,
      before,
    );
    return inputsFromEntries(entries, windowStart, windowEnd, options, truncated);
  }

  /**
   * `entries` with content restored for those of `types` the store returned without
   * it, read back one list per type over the same window. Each list holds the newest
   * `scanCap` entries of its type, which covers every one of them in `entries`.
   */
  private async withContentFor(
    entries: Entry[],
    types: ReadonlySet<string>,
    after: Date,
    before: Date,
  ): Promise<Entry[]> {
    const missing = new Set<string>();
    for (const entry of entries) {
      if (entry.content === null && types.has(entry.type)) missing.add(entry.type);
    }
    if (missing.size === 0) return entries;
    const full = new Map<string, Entry>();
    const lists = await Promise.all(
      [...missing].map((type) => this.store.list({ type, after, before, size: this.scanCap })),
    );
    for (const list of lists) for (const entry of list) full.set(entry.id, entry);
    return entries.map((entry) => full.get(entry.id) ?? entry);
  }

  /** The entries among `entries` that lack content, read back by id. */
  private async withContentById(entries: Entry[]): Promise<Map<string, Entry>> {
    const ids = new Set<string>();
    for (const entry of entries) if (entry.content === null) ids.add(entry.id);
    const found = await Promise.all([...ids].map((id) => this.store.get(id)));
    const byId = new Map<string, Entry>();
    for (const entry of found) if (entry !== null) byId.set(entry.id, entry);
    return byId;
  }

  /** For each N+1 hotspot, the newest entry of its family in its sample trace (for its SQL). */
  private async nPlusOneSamples(
    hotspots: NPlusOneAccumulator[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Map<string, Entry>> {
    const samples = new Map<string, Entry>();
    await Promise.all(
      hotspots.map(async ({ sampleTraceId, familyHash }) => {
        const [sample] = await this.store.list({
          traceId: sampleTraceId,
          familyHash,
          after: windowStart,
          before: new Date(windowEnd.getTime() + 1),
          size: 1,
        });
        if (sample !== undefined) samples.set(`${sampleTraceId}\u0000${familyHash}`, sample);
      }),
    );
    return samples;
  }
}

/** The optional store reads Pulse's whole-window path needs. */
type PulseFastPath = 'countByBucket' | 'listSlowest' | 'countTraceRepeats';

function hasPulseFastPaths(
  store: TelescopeStore,
): store is TelescopeStore & Required<Pick<TelescopeStore, PulseFastPath>> {
  return (
    typeof store.countByBucket === 'function' &&
    typeof store.listSlowest === 'function' &&
    typeof store.countTraceRepeats === 'function'
  );
}

/** `configured` narrowed to `asked` (unknown names dropped); `configured` when none is left. */
function narrowCards(
  configured: ReadonlySet<PulseCardName>,
  asked: readonly string[] | undefined,
): ReadonlySet<PulseCardName> {
  if (asked === undefined) return configured;
  const narrowed = new Set<PulseCardName>();
  for (const card of asked) {
    if (configured.has(card as PulseCardName)) narrowed.add(card as PulseCardName);
  }
  return narrowed.size > 0 ? narrowed : configured;
}

/** The entry types whose content the enabled cards aggregate over. */
function contentTypes(cards: ReadonlySet<PulseCardName>): ReadonlySet<string> {
  const types = new Set<string>();
  if (cards.has('requests') || cards.has('slowRoutes')) types.add(EntryType.Request);
  if (cards.has('cache')) types.add(EntryType.Cache);
  if (cards.has('exceptions')) for (const type of EXCEPTION_ENTRY_TYPES) types.add(type);
  return types;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampBuckets(buckets: number | undefined): number {
  return Math.min(MAX_BUCKETS, Math.max(1, Math.floor(buckets ?? DEFAULT_BUCKETS)));
}
