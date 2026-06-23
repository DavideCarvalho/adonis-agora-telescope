import type { AlertChannel } from './alert_channel.js';

/**
 * A single alerting rule. Ported (trimmed) from the aviary telescope core. This
 * Adonis port focuses on the two rules the headless `@adonis-agora/telescope` store can
 * back today:
 *
 * - `new-exception`  — fires the FIRST time an exception's `familyHash` is seen
 *                      within `window` (a genuinely NEW error family), and again
 *                      if the family re-appears after the window has elapsed (the
 *                      "re-occurring after being resolved" signal). Deduplication
 *                      is per-process via {@link NewExceptionTracker}.
 * - `exception-rate` — fires when `>= threshold` exception entries were recorded
 *                      in the trailing `window`.
 */
export type AlertRule =
  | { type: 'new-exception'; window: string }
  | { type: 'exception-rate'; window: string; threshold: number };

/**
 * Rich exception context attached to a `new-exception` alert. Pulled from the
 * exception {@link Entry} that fired the rule. Absent on rate-rule alerts.
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
  /** Request method, or `null`. */
  method: string | null;
  /** Response status code, or `null`. */
  statusCode: number | null;
  /** Authenticated user id from a `user:<id>` tag, or `null`. */
  user: string | null;
  /** Times this family was seen in the window (>= 1; 1 on first-occurrence). */
  occurrences: number;
  /** Exception entry id (for the dashboard deep link). */
  entryId: string;
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
  /** Rich context for `new-exception` alerts; absent for rate rules. */
  exception?: ExceptionAlertContext;
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
}
