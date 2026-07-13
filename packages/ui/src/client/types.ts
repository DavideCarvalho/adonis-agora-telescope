/**
 * Wire shapes returned by the `@adonis-agora/telescope` UI provider's read routes (`<path>/api/*`).
 * These MIRROR the core's own types (`src/entry.ts`, `src/ui/api.ts`, `src/metrics/*`) exactly — the
 * SPA is a pure consumer, so any drift here is a bug against the server contract, not a local choice.
 * Note the wire quirks: all success bodies are wrapped `{ data, meta? }`; `Date` fields inside
 * metrics/trace payloads (`firstAt`, `lastAt`) arrive as ISO strings; SSE emits an {@link EntrySummary}.
 */

/** The built-in entry types (mirrors core `EntryType`). `Entry.type` is a plain string — custom
 *  watcher/extension types are allowed — but these are the known values. */
export const ENTRY_TYPES = [
  'request',
  'query',
  'exception',
  'client_exception',
  'job',
  'mail',
  'cache',
  'redis',
  'event',
  'log',
  'http-client',
  'diagnostic',
] as const;

export type KnownEntryType = (typeof ENTRY_TYPES)[number];

/** Batch origin — where the recording happened (mirrors core `BatchOrigin`). */
export type BatchOrigin = 'http' | 'queue' | 'schedule' | 'cli' | 'manual';

/** A trimmed list-row / SSE projection of an entry (drops the heavy `content`). */
export interface EntrySummary {
  id: string;
  type: string;
  familyHash: string | null;
  tags: string[];
  traceId: string | null;
  durationMs: number | null;
  sequence: number;
  createdAt: string;
  /** Derived one-liner: `METHOD url → status` | `lib:event` | message | familyHash | type. */
  summary: string;
}

/** A full captured entry (from `GET <base>/entries/:id`). `content` is type-specific. */
export interface Entry<TContent = unknown> {
  id: string;
  type: string;
  familyHash: string | null;
  content: TContent;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: BatchOrigin;
  traceId: string | null;
  createdAt: string;
}

/** The recorded body of a `request` entry (mirrors core `RequestEntryContent`). */
export interface RequestEntryContent {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  traceId: string | null;
}

/** The AND-composed filter set the `/entries` list route accepts. */
export interface EntriesQuery {
  type?: string;
  tag?: string;
  traceId?: string;
  search?: string;
  /** Keyset cursor: strictly older than this ISO timestamp (pass the oldest row's `createdAt`). */
  before?: string;
  limit?: number;
}

/** A `{ key, count }` bucket (top families / top tags). */
export interface CountBucket {
  key: string;
  count: number;
}

/** `GET <base>/stats` payload. */
export interface StatsOverview {
  count: number;
  topFamilies: CountBucket[];
  topTags: CountBucket[];
}

// ── metrics ──────────────────────────────────────────────────────────────────

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  slow: number;
}

export interface FamilyLatency {
  familyHash: string;
  label: string;
  count: number;
  p50: number;
  p99: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  hitRatio: number;
  topKeys: CountBucket[];
}

export interface StatusBreakdown {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  other: number;
}

export interface ExceptionGroupStats {
  key: string;
  class: string;
  message: string;
  count: number;
  /** ISO over the wire (a `Date` server-side). */
  lastAt: string;
  overTime: number[];
}

export interface TimeseriesBucket {
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

export interface StatsResult {
  type: string;
  windowMs: number;
  total: number;
  overTime: TimeseriesReport;
  latency?: LatencyStats;
  families?: FamilyLatency[];
  cache?: CacheStats;
  status?: StatusBreakdown;
  exceptions?: ExceptionGroupStats[];
  truncated: boolean;
}

export interface TraceSummary {
  traceId: string;
  entryCount: number;
  types: string[];
  /** ISO over the wire. */
  firstAt: string;
  /** ISO over the wire. */
  lastAt: string;
  totalDurationMs: number;
  rootLabel?: string;
}

export interface WaterfallSpan {
  id: string;
  type: string;
  label: string;
  offsetMs: number;
  durationMs: number;
  depth: number;
  sequence: number;
  children: WaterfallSpan[];
}

export interface Waterfall {
  traceStartMs: number;
  totalDurationMs: number;
  spans: WaterfallSpan[];
}

export interface NPlusOnePattern {
  childFamilyHash: string;
  childSql: string;
  count: number;
  totalDurationMs: number;
  parentFamilyHash: string | null;
  parentSql: string | null;
  representativeId: string;
  traceId: string;
}

// ── pulse ────────────────────────────────────────────────────────────────────

export interface PulseThroughput {
  total: number;
  perMinute: number;
  overTime: TimeseriesReport;
}

export interface PulseRequestHealth {
  total: number;
  errorRate: number;
  status: StatusBreakdown;
  latency?: LatencyStats;
}

export interface PulseSlowEntry {
  id: string;
  type: string;
  durationMs: number;
  label: string;
  traceId: string | null;
}

export interface PulseHotspot {
  route: string;
  count: number;
  p99: number;
  p50: number;
}

export interface PulseExceptionGroup {
  key: string;
  class: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface PulseNPlusOne {
  familyHash: string;
  sql: string;
  perRequest: number;
  traces: number;
  total: number;
  totalDurationMs: number;
  sampleTraceId: string;
}

export interface PulseUserLoad {
  user: string;
  count: number;
  totalDurationMs: number;
}

export interface PulseSummary {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  throughput: PulseThroughput;
  requests: PulseRequestHealth;
  cache?: CacheStats;
  slowest: PulseSlowEntry[];
  slowRoutes: PulseHotspot[];
  slowOutgoing: PulseHotspot[];
  slowJobs: PulseHotspot[];
  topExceptions: PulseExceptionGroup[];
  nPlusOne: PulseNPlusOne[];
  loadByUser: PulseUserLoad[];
  scanned: number;
  truncated: boolean;
}

/** The standard success envelope every route wraps its payload in. */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}
