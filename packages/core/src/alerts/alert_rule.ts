import type { AlertChannel } from './alert_channel.js';

/**
 * A single alerting rule. Ported (trimmed) from the aviary telescope core.
 *
 * Two families of rules, evaluated by two complementary services:
 *
 * - `new-exception` / `exception-rate` — the exception-driven rules the
 *   {@link Alerter} evaluates over a freshly-polled batch of exception entries
 *   (fed by the {@link ExceptionPoller}). They fire-and-cooldown; they do NOT
 *   auto-resolve.
 *     - `new-exception`  fires the FIRST time an exception's `familyHash` is seen
 *                        within `window` (a genuinely NEW error family), and
 *                        again if the family re-appears after the window elapses.
 *                        Dedup is per-process via {@link NewExceptionTracker}.
 *     - `every-exception` fires for EVERY exception (server + browser-reported
 *                        `client_exception`), not just brand-new families —
 *                        parity with a "notify on every error" setup. Still
 *                        rate-limited by the shared `cooldown` PER FAMILY (on an
 *                        independent clock from `new-exception`), so a hot loop of
 *                        the same error re-pages once per cooldown rather than on
 *                        every occurrence. The optional `window` is used only to
 *                        count occurrences shown on the alert; it does NOT gate firing.
 *     - `exception-rate` fires when `>= threshold` exception entries were recorded
 *                        in the trailing `window`.
 *
 * - `metric-threshold` — the stateful rule the {@link AlerterService} evaluates on
 *   an interval over a trailing `window`, reusing the SAME windowed aggregation
 *   the dashboard shows (`summarizeStats`/`percentile` via `MetricsService`), so
 *   an alert means exactly what the metrics view shows. It RAISES when the
 *   computed metric first crosses `threshold` in the `comparator` direction and
 *   AUTO-RESOLVES when it clears — with dedup (no duplicate raise while active)
 *   and a post-resolve cooldown for flap control. Use it to page on
 *   "request p99 > 800ms" (a slow endpoint), "cache hit-rate < 0.8", or an
 *   exception spike (`exception-count >= N`).
 */
export type AlertRule =
  | { type: 'new-exception'; window: string }
  | { type: 'every-exception'; window?: string }
  | { type: 'exception-rate'; window: string; threshold: number }
  | {
      type: 'metric-threshold';
      /** The computed metric to evaluate (see {@link AlertMetric}). */
      metric: AlertMetric;
      /** Trailing window to aggregate over (e.g. `'5m'`). */
      window: string;
      /** `gte` fires when value >= threshold; `lte` when value <= threshold. */
      comparator: 'gte' | 'lte';
      /** The threshold the metric is compared against. */
      threshold: number;
      /**
       * Minimum samples in the window before a percentile/ratio rule can fire —
       * guards a p99 page against a single slow request on a quiet host. Default
       * 1. Ignored for `exception-count` (a count of 0 is a meaningful value that
       * must be able to auto-resolve a firing spike).
       */
      minSamples?: number;
    };

/**
 * The metrics a `metric-threshold` rule can evaluate. Each is derived from the
 * SAME windowed aggregation the stats view uses (`summarizeStats`), so an alert
 * means exactly what the dashboard shows. Latency metrics are in ms;
 * `cache-hit-rate` is a ratio in [0, 1]; `exception-count` is a raw count.
 */
export type AlertMetric =
  | 'request-p95-ms'
  | 'request-p99-ms'
  | 'query-p95-ms'
  | 'query-p99-ms'
  | 'cache-hit-rate'
  | 'exception-count';

/**
 * A coarse geo location resolved from a client IP, attached to an exception alert
 * when a {@link GeoLookup} hook is configured. Every field is optional — a partial
 * result (e.g. country only) still renders. Deliberately dependency-light: the LIB
 * ships no geo database or HTTP client; the host owns the lookup (and its
 * caching/rate-limiting) and returns this shape.
 */
export interface AlertGeoLocation {
  city?: string;
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2 (e.g. `US`), used to render a flag emoji. */
  countryCode?: string;
}

/**
 * Host-supplied resolver from a client IP to a coarse {@link AlertGeoLocation}.
 * Called ONLY when an exception alert actually fires and carries a `clientIp`, so
 * the common no-fire path pays nothing. May be sync or async; returning `null`
 * (or throwing — swallowed) simply omits the Location field. The lib never caches
 * or rate-limits it — do that in the hook if the provider needs it.
 */
export type GeoLookup = (ip: string) => AlertGeoLocation | null | Promise<AlertGeoLocation | null>;

/**
 * Rich exception context attached to a `new-exception` / `every-exception` alert.
 * Pulled from the exception {@link Entry} that fired the rule. Absent on rate-rule
 * alerts.
 */
export interface ExceptionAlertContext {
  /** Stable family hash that was first-seen this window. */
  familyHash: string;
  /** Exception class name (e.g. `TypeError`). */
  class: string;
  /** Exception message. */
  message: string;
  /** Truncated stack (first frames), or `null`. */
  stack: string | null;
  /** Request route/uri associated with the exception, or `null`. */
  route: string | null;
  /** Request method, or `null` (always `null` for a client_exception). */
  method: string | null;
  /** Response status code, or `null`. */
  statusCode: number | null;
  /**
   * User-agent string. For a `client_exception` it's the reporting browser's UA;
   * for a server exception it's the sibling request's UA (when captured). `null`
   * when unavailable.
   */
  userAgent: string | null;
  /**
   * `Referer` header of the originating request (server exception) — the page a
   * user came from. `null` when absent or for a `client_exception` (the browser
   * report carries its own page `url` in `route`, not a referer).
   */
  referer: string | null;
  /**
   * React component stack from an error boundary — present ONLY for a
   * `client_exception` that supplied one. `null` otherwise.
   */
  componentStack: string | null;
  /**
   * Host-defined free-form debugging bag from a `client_exception` (`extra`), or
   * `null`. Redacted/bounded at record time like any other content.
   */
  extra: Record<string, unknown> | null;
  /** True when this alert is a browser-reported `client_exception`. */
  client: boolean;
  /**
   * Originating client IP, or `null` when unknown. For a `client_exception` it's
   * the browser IP the ingestion endpoint filled in server-side (`clientIp`);
   * for a server exception it's the recorded request IP when available. NEVER
   * sourced from an untrusted body.
   */
  clientIp: string | null;
  /**
   * Coarse geo location resolved from {@link clientIp}, or `null`. Populated only
   * when a {@link GeoLookup} hook is configured AND the alert has a `clientIp`;
   * otherwise `null`.
   */
  geo: AlertGeoLocation | null;
  /** Request duration (ms), or `null`. */
  durationMs: number | null;
  /** Authenticated user id from a `user:<id>` tag, or `null`. */
  user: string | null;
  /** Times this family was seen in the window (>= 1; 1 on first-occurrence). */
  occurrences: number;
  /** Exception entry id (for the dashboard deep link). */
  entryId: string;
}

/**
 * A compact AI probable-cause summary optionally attached to a `new-exception`
 * alert by the {@link Alerter} when a diagnosis coordinator is configured. Kept
 * structural (no dependency on the `ai` subpath) so alerting stays independent of
 * whether AI is installed. Absent when AI is off or a diagnosis wasn't ready.
 */
export interface AlertDiagnosis {
  /** Likely root cause — what failed and why. */
  cause: string;
  /** A concrete, actionable suggested fix. */
  fix: string;
  /** The model's confidence (`high` / `medium` / `low`). */
  confidence: string;
  /** The model id that produced the diagnosis. */
  model: string;
}

/**
 * The shape delivered to every {@link AlertChannel} when a rule fires.
 */
export interface AlertPayload {
  rule: AlertRule;
  /** The measured value that crossed the threshold. */
  value: number;
  /** The rule's threshold (`threshold`, or `1` for `new-exception`). */
  threshold: number;
  /** ISO-8601 fire time. */
  firedAt: string;
  /** The reporting instance identifier. */
  instanceId: string;
  /**
   * Whether this notification RAISES an alert or RESOLVES a previously-raised one.
   * Present on stateful `metric-threshold` alerts; absent (⇒ `'firing'`) on the
   * fire-and-cooldown exception rules, which carry no resolve signal.
   */
  status?: 'firing' | 'resolved';
  /** The evaluated metric — present on `metric-threshold` alerts. */
  metric?: AlertMetric;
  /** Rich context for `new-exception` alerts; absent for rate/metric rules. */
  exception?: ExceptionAlertContext;
  /**
   * AI probable-cause analysis, attached to a `new-exception` alert when a
   * diagnosis coordinator is configured and produced a result within the grace
   * window. Absent when AI is off or no diagnosis was ready. Channels render it as
   * a "Probable cause (AI)" section; the raw webhook payload carries it verbatim.
   */
  diagnosis?: AlertDiagnosis;
  /** External dashboard URL when configured (lets channels build deep links). */
  dashboardUrl?: string;
}

/**
 * Validated, boot-resolved alerting config (durations normalized to ms).
 */
export interface ResolvedAlerts {
  /** Whether alerting is active. */
  enabled: boolean;
  /** All delivery destinations. */
  channels: AlertChannel[];
  /** External dashboard URL for deep links, or `null` when unset. */
  dashboardUrl: string | null;
  /** Poll cadence for the exception-entry source, in ms. */
  intervalMs: number;
  /** Per-rule / per-family re-notify suppression, in ms. */
  cooldownMs: number;
  /** The reporting instance identifier. */
  instanceId: string;
  /** Rules to evaluate. */
  rules: AlertRule[];
  /** Host IP→geo resolver, or `null` when unconfigured. */
  geoLookup: GeoLookup | null;
}
