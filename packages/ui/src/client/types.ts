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
  /**
   * The entry's user (`email` ?? `id`), when its content carried a captured user
   * (e.g. a `request` or `client_exception`).
   */
  userLabel?: string;
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
  /**
   * The authenticated user at request time, when the host exposes `ctx.auth.user`
   * (Adonis @adonisjs/auth / authkit guard). Only `id` and `email` are captured —
   * never the full model. `null` when unauthenticated or not exposed.
   */
  user: { id: string; email?: string } | null;
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
  /** `exception` (server) or `client_exception` (browser) — what the group's rows link to. */
  type: string;
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
  /** The request entry's user label (`email` ?? `id`), when the trace has one. */
  userLabel?: string;
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

/**
 * A page of rows plus whether another one exists.
 *
 * `hasMore` and not `total`: the paginated endpoints answer it by fetching one row
 * past the page, because counting would mean an aggregate over the very table the
 * pagination exists to stop scanning. Prev/Next needs no total.
 */
export interface Page<T> {
  rows: T[];
  page: number;
  hasMore: boolean;
}

// ── retention (`GET <base>/retention`) ──────────────────────────────────────

/** One entry type recording below 100%, from the resolved sampling config. */
export interface RetentionSamplingRate {
  type: string;
  rate: number;
}

/** The static retention/sampling posture — no live pruner run history. */
export interface RetentionInfo {
  enabled: boolean;
  afterMs: number;
  keepLast: number | null;
  intervalMs: number;
  sampling: RetentionSamplingRate[];
}

// ── extension dashboards (`GET <base>/meta`, `GET <base>/ext/:ext/data/:provider`) ─────────────
// Mirrors the core extension SDK's panel IR (`src/extension/types.ts`) exactly — the SPA is a pure
// consumer of whatever an extension (e.g. a sibling lib) contributed at boot.

/** A navigable entry type contributed by an extension. */
export interface ExtensionEntryType {
  id: string;
  label: string;
  /** A CSS color (any valid `color` value) for the nav dot. */
  dot: string;
}

/** Threshold coloring for a numeric panel. `direction` says which way is worse. */
export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

/** A bind from a panel to a named server-side provider + an opaque query object. */
export interface DataBinding {
  provider: string;
  query?: Record<string, unknown>;
}

/** A deep-link out of a table cell. `href` starting with `#` is unsupported here (no router);
 *  anything else is rendered as a plain link, opened in a new tab when `external`. */
export interface LinkSpec {
  href: string;
  external?: boolean;
}

export interface PanelColumn {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | {
      kind: 'table';
      title: string;
      data: DataBinding;
      columns: PanelColumn[];
      paged?: boolean;
    }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

/** A group of panels rendered together with its own column count. */
export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

/** A declarative dashboard page contributed by an extension. */
export interface DashboardSpec {
  id: string;
  label: string;
  navGroup?: string;
  panels: Panel[];
  sections?: DashboardSection[];
}

/** `GET <base>/meta` payload. */
export interface TelescopeMeta {
  entryTypes: ExtensionEntryType[];
  dashboards: DashboardSpec[];
  /** Whether `@adonis-agora/telescope/ai` is installed and configured — gates the "Diagnose with AI"
   *  action on exception entries. Absent (treated as disabled) on a server predating this field. */
  ai?: { enabled: boolean };
  /** Whether `@adonis-agora/telescope/cpu_profiling` is installed — gates the Profiles section. */
  profiling?: { enabled: boolean };
  /** Whether the live queue manager capability is enabled — gates the Queues section. */
  queueManager?: { enabled: boolean };
}

// ── CPU profiling (`GET/POST <base>/profiles*`) ─────────────────────────────

export interface FlameNode {
  name: string;
  file: string;
  totalMs: number;
  selfMs: number;
  totalSamples: number;
  children: FlameNode[];
}

export interface HotFrame {
  name: string;
  file: string;
  selfMs: number;
  selfPct: number;
}

/** The recorded body of a `cpu_profile` entry (mirrors core `CpuProfileContent`). */
export interface CpuProfileContent {
  durationMs: number;
  sampleCount: number;
  reason: 'manual' | 'sampled';
  label: string | null;
  tree: FlameNode;
  hot: HotFrame[];
}

/** `GET <base>/profiles/status` payload. */
export interface ProfilerStatus {
  enabled: boolean;
  sampleRate: number;
  active: number;
  maxConcurrent: number;
  pendingManual: number;
}

/** `POST <base>/profiles/arm` payload. */
export interface ArmProfileResult {
  pendingManual: number;
}

/** The client's arm outcome — never throws on a "arming unavailable" 4xx, so the UI can render why
 *  inline (disabled feature, disabled trigger, bad count) instead of an error boundary. */
export type ArmOutcome = ({ ok: true } & ArmProfileResult) | { ok: false; message: string };

// ── live queue manager (`GET/POST <base>/queues/live*`) ────────────────────

export type QueueState = 'pending' | 'active' | 'delayed' | 'failed' | 'completed';
export type QueueActionName = 'retry' | 'remove' | 'promote' | 'enqueue';

export interface QueueCounts {
  pending: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  completed: number | null;
}

export interface QueueSummary {
  driver: string;
  queue: string;
  counts: QueueCounts;
  actions: QueueActionName[];
}

export interface QueueJob {
  id: string;
  name: string | null;
  state: QueueState | null;
  attemptsMade: number | null;
  maxAttempts: number | null;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  failedReason: string | null;
}

export interface QueueJobDetail extends QueueJob {
  payload: unknown;
  result: unknown;
}

export interface QueueCapabilities {
  mutationsEnabled: boolean;
  actions: QueueActionName[];
}

/** `GET <base>/queues/live` payload. */
export interface LiveQueues {
  queues: QueueSummary[];
  capabilities: QueueCapabilities;
}

/** The client's job-retry outcome — never throws on a "not supported"/disabled 4xx/501. */
export type RetryJobOutcome = { ok: true } | { ok: false; message: string };

/** The client's enqueue outcome — never throws on a "not supported"/disabled 4xx/501. */
export type EnqueueOutcome = { ok: true; id: string | null } | { ok: false; message: string };

// ── live schedules (`GET <base>/schedules/live`) ────────────────────────────

export type ScheduleKind = 'cron' | 'interval' | 'custom';
export type ScheduleRunStatus = 'completed' | 'failed';

export interface LiveScheduledTask {
  name: string;
  kind: ScheduleKind;
  schedule: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: ScheduleRunStatus | null;
}

/** `GET <base>/schedules/live` payload. */
export interface LiveSchedules {
  tasks: LiveScheduledTask[];
}

// ── AI exception diagnosis (`POST <base>/exceptions/:id/diagnose`) ─────────

/** A successful `POST .../diagnose` response body. */
export interface DiagnosisResult {
  /** Rendered as markdown (heading + confidence/model line + cause + suggested fix). */
  markdown: string;
  /** Whether this diagnosis was served from the family-hash cache (vs a fresh model call). */
  cached: boolean;
}

/** The client's diagnose outcome — never throws on a "no diagnosis" 4xx/5xx, so the UI can render
 *  a failure message inline instead of an error boundary. */
export type DiagnoseOutcome = ({ ok: true } & DiagnosisResult) | { ok: false; message: string };

// ── request replay (`POST <base>/requests/:id/replay`) ─────────────────────

/** The outcome of re-issuing a captured `request` entry against the live server. */
export interface ReplayResult {
  status: number;
  durationMs: number;
  body: string;
  error?: string;
}

/** The client's replay outcome — never throws on a "replay unavailable" 4xx, so the UI can render
 *  why inline (e.g. "disabled" / "not found") instead of an error boundary. */
export type ReplayOutcome = ({ ok: true } & ReplayResult) | { ok: false; message: string };

// ── extension panel data shapes (per-kind `resolve()` return value) ────────

export interface StatPanelData {
  value: number;
  delta?: number;
  deltaLabel?: string;
  spark?: number[];
}

export interface TimeseriesPanelRow {
  label: string;
  [series: string]: string | number;
}

export interface TimeseriesPanelData {
  rows: TimeseriesPanelRow[];
}

export interface TopNPanelItem {
  label: string;
  value: number;
  id?: string;
}

export interface TopNPanelData {
  items: TopNPanelItem[];
}

export interface TablePanelData {
  rows: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  limit?: number;
}

export interface DistributionPanelData {
  buckets: Array<{ label: string; count: number }>;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface GaugePanelData {
  value: number;
  min?: number;
  max?: number;
}

export interface BreakdownPanelData {
  segments: Array<{ label: string; value: number; color?: string }>;
}
