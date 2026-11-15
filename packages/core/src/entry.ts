import { randomUUID } from 'node:crypto';
/**
 * The built-in Telescope entry types shipped by `@adonis-agora/telescope`. Adapted from
 * the NestJS `nestjs-telescope` core, trimmed to the headless slice this package
 * actually records (request + diagnostic). The remaining values are reserved so a
 * future watcher (a Lucid query watcher, a mailer watcher, …) can record under a
 * stable, already-documented type without a breaking change.
 */
export const EntryType = {
  /** An inbound HTTP request, recorded by {@link TelescopeMiddleware}. */
  Request: 'request',
  /** A single `agora:<lib>:<event>` diagnostics publish. */
  Diagnostic: 'diagnostic',
  // — reserved for deferred per-tech watchers (see DESIGN.md) —
  Query: 'query',
  Job: 'job',
  Exception: 'exception',
  Mail: 'mail',
  Cache: 'cache',
  Redis: 'redis',
  Event: 'event',
  Log: 'log',
  /** An OUTBOUND HTTP call, recorded by the http-client watcher. */
  HttpClient: 'http-client',
  /**
   * A user-instrumented profiling span — a timed code section (label, duration,
   * nested marks) recorded by the profiling watcher's `profile()` / `startProfile()`
   * helpers. Self-contained timing, not a V8 CPU capture.
   */
  Profile: 'profile',
  /**
   * A single scheduled-task run (name, cron/expression, duration, success/failure),
   * recorded by the schedule watcher's `scheduleTask()` / `recordScheduledRun()`
   * helpers. Distinct from a queue {@link EntryType.Job} so schedule health rolls
   * up separately.
   */
  ScheduledTask: 'scheduled_task',
  /**
   * A browser/client-reported error ingested via the public client-error
   * endpoint (`POST <path>`). Recorded through the normal pipeline with a
   * family-hash mirroring server exceptions and `failed`/`client`/`user:<id>`
   * tags, so it composes with dedup, prune, sampling, and the dashboard.
   */
  ClientException: 'client_exception',
  /**
   * An aggregated V8 CPU profile (flamegraph tree + precomputed hot frames)
   * captured via `node:inspector`'s `Profiler.start`/`Profiler.stop`, recorded
   * by the OPTIONAL `cpu_profiling` feature (`@adonis-agora/telescope/cpu_profiling`).
   * Distinct from {@link EntryType.Profile} (user-instrumented timing spans) —
   * this is a real V8 sampling-profiler capture.
   */
  CpuProfile: 'cpu_profile',
  /**
   * A span the app's OpenTelemetry instrumentation produced (a pg query, a DNS lookup, an
   * event listener, a custom span), ingested by `telescopeSpanProcessor()` from
   * `@adonis-agora/telescope/otel` so it shows in the trace waterfall next to telescope's
   * own entries.
   */
  Span: 'span',
} as const;

export type BuiltinEntryType = (typeof EntryType)[keyof typeof EntryType];

/**
 * The entry types that represent a CAPTURED ERROR: a server-side `exception` and
 * a browser-reported `client_exception`.
 *
 * Defined once, on purpose. This list used to live only inside the alert poller
 * while the metrics/dashboard side hard-coded `EntryType.Exception` alone, and the
 * two silently disagreed: a front-end-only incident paged on Slack/Discord and
 * simultaneously rendered "Error rate 0.0% · No exceptions recorded 🎉" on the
 * overview. Anything answering "is this an error?" should read THIS.
 */
export const EXCEPTION_ENTRY_TYPES = [EntryType.Exception, EntryType.ClientException] as const;

/** Whether `type` is one of {@link EXCEPTION_ENTRY_TYPES} (server or browser). */
export function isExceptionType(type: string): boolean {
  return type === EntryType.Exception || type === EntryType.ClientException;
}

/**
 * Where a batch of entries originated. An entry recorded inside an HTTP request
 * is `http`; one recorded by a queue worker is `queue`; a diagnostic recorded
 * with no active request defaults to `manual`.
 */
const BATCH_ORIGINS = ['http', 'queue', 'schedule', 'cli', 'manual'] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export function isBatchOrigin(value: unknown): value is BatchOrigin {
  return typeof value === 'string' && (BATCH_ORIGINS as readonly string[]).includes(value);
}

/**
 * A captured, persisted observability record. `content` is type-specific (e.g.
 * {@link RequestEntryContent} for a `request`, {@link DiagnosticEntryContent} for
 * a `diagnostic`).
 */
export interface Entry<TContent = unknown> {
  /** Unique id of this entry. */
  id: string;
  /** The entry type, one of {@link EntryType} (or a custom string). */
  type: string;
  /**
   * Stable grouping key — entries that share a `familyHash` are "the same kind of
   * thing" (e.g. all `billing:invoice-paid` diagnostics). `null` when the entry
   * is not groupable.
   */
  familyHash: string | null;
  /** The type-specific payload. */
  content: TContent;
  /** Searchable labels, e.g. `lib:billing`, `event:invoice-paid`, `status:500`. */
  tags: string[];
  /** Monotonic record order within this process. */
  sequence: number;
  /** Wall-clock duration of the recorded operation, when known. */
  durationMs: number | null;
  /** Where the recording happened. */
  origin: BatchOrigin;
  /** The active trace id at record time, or `null` when no context. */
  traceId: string | null;
  /** When the entry was recorded. */
  createdAt: Date;
}

/**
 * What a watcher hands to {@link TelescopeStore.record}. The store fills in `id`,
 * `sequence`, `createdAt`, and resolves `traceId`/`origin` from the ambient
 * context when the caller omits them. `id` and `createdAt` may be given (an entry recorded
 * elsewhere and stored here later); see {@link resolveEntryId} and {@link resolveCreatedAt}.
 */
export interface RecordInput<TContent = unknown> {
  type: string;
  content: TContent;
  familyHash?: string | null;
  tags?: string[];
  durationMs?: number | null;
  /** Override the resolved trace id; defaults to the ambient `@adonis-agora/context`. */
  traceId?: string | null;
  /** Override the batch origin; defaults to `http` when a request is active. */
  origin?: BatchOrigin;
  /**
   * When the entry happened, for an entry recorded elsewhere and stored later. Defaults to now.
   * A time more than {@link MAX_FUTURE_SKEW_MS} ahead, or an invalid one, becomes now.
   */
  createdAt?: Date | string;
  /**
   * The entry's id, for an entry recorded elsewhere. Recording an id the store already holds
   * stores nothing new. Defaults to a fresh UUID; an id that is not 1–255 printable characters is
   * replaced by one.
   */
  id?: string;
}

/** How far ahead of the clock a given `createdAt` may be before it is taken as now. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** The `createdAt` of a recorded entry: the given time when sane, else now. */
export function resolveCreatedAt(value: Date | string | undefined, now: number = Date.now()): Date {
  if (value === undefined) return new Date(now);
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(at) || at < 0 || at > now + MAX_FUTURE_SKEW_MS) return new Date(now);
  return new Date(at);
}

const ENTRY_ID_RE = /^[\x21-\x7e]{1,255}$/;

/** The id of a recorded entry: the given one when it is 1–255 printable ASCII characters, else a UUID. */
export function resolveEntryId(value: unknown): string {
  return typeof value === 'string' && ENTRY_ID_RE.test(value) ? value : randomUUID();
}
