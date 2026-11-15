import type { AlertChannel } from '../alert_channel.js';
import type { AlertPayload, AlertRule, AlertSeverity } from '../alert_rule.js';

/**
 * What every integration derives from an {@link AlertPayload}: one incident key
 * per rule + app (so one incident is never paged twice), a severity, and a
 * short human title/summary.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/**
 * Default severity per rule kind. Kinds not listed here (including rule kinds a
 * newer release adds) fall back to `error`.
 */
const DEFAULT_SEVERITY: Record<string, AlertSeverity> = {
  'new-exception': 'error',
  'every-exception': 'error',
  'exception-rate': 'critical',
  'metric-threshold': 'warning',
  'instances-up': 'critical',
  'restart-loop': 'critical',
  'check-down': 'critical',
  'entries-dropped': 'warning',
};

/** The rule's own `severity`, else the default for its kind. */
export function severityOf(alert: AlertPayload): AlertSeverity {
  const rule = alert.rule as AlertRule & { severity?: AlertSeverity };
  return rule.severity ?? DEFAULT_SEVERITY[rule.type] ?? 'error';
}

/** `true` when `severity` is at least `min`. */
export function meetsSeverity(severity: AlertSeverity, min: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** `firing` unless the payload says it resolves a raised alert. */
export function statusOf(alert: AlertPayload): 'firing' | 'resolved' {
  return alert.status ?? 'firing';
}

/**
 * What a per-app (fleet) alert is about. Read structurally so the integrations
 * work with rules that carry a `fleet` context (`instances-up`, `check-down`, …).
 */
interface SubjectLike {
  app?: unknown;
  check?: unknown;
  host?: unknown;
  detail?: unknown;
}

function subjectOf(alert: AlertPayload): SubjectLike | null {
  const fleet = (alert as AlertPayload & { fleet?: unknown }).fleet;
  return fleet !== null && typeof fleet === 'object' ? (fleet as SubjectLike) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The app an alert is about: the fleet alert's app, else the reporting instance. */
export function appOf(alert: AlertPayload): string {
  return str(subjectOf(alert)?.app) ?? alert.instanceId;
}

/** A fleet alert's one-line detail (e.g. "Redis down for 12 min"), or `null`. */
export function detailOf(alert: AlertPayload): string | null {
  return str(subjectOf(alert)?.detail);
}

/**
 * The stable identity of a rule, independent of the value it measured — so the
 * firing and the resolving notification of the same rule share it.
 */
function ruleIdentity(rule: AlertRule): string {
  const parts: string[] = [rule.type];
  const loose = rule as unknown as Record<string, unknown>;
  for (const field of ['metric', 'comparator', 'threshold', 'window', 'below', 'for']) {
    const value = loose[field];
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  return parts.join(':');
}

/**
 * The deduplication key for an alert: `telescope:<app>:<rule>[:<exception family>]`.
 * PagerDuty's `dedup_key`, Opsgenie's `alias`, incident.io's `deduplication_key`
 * and Grafana OnCall's `alert_uid` all use it, so a trigger repeated while the
 * incident is open is folded into it, and the resolve closes the right one.
 */
export function incidentKey(alert: AlertPayload): string {
  const subject = subjectOf(alert);
  const parts = [`telescope:${appOf(alert)}:${ruleIdentity(alert.rule)}`];
  const check = str(subject?.check);
  const host = str(subject?.host);
  if (check !== null) parts.push(`check=${check}`);
  if (host !== null) parts.push(`host=${host}`);
  const family = alert.exception?.familyHash;
  if (family !== undefined) parts.push(family);
  return parts.join(':');
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** One-line title, e.g. `[firing] TypeError: cannot read x (POST /checkout)`. */
export function titleOf(alert: AlertPayload): string {
  const prefix = statusOf(alert) === 'resolved' ? '[resolved]' : `[${severityOf(alert)}]`;
  const app = appOf(alert);
  if (alert.exception !== undefined) {
    const { class: cls, message, route, method } = alert.exception;
    const where = route !== null ? ` (${method !== null ? `${method} ` : ''}${route})` : '';
    return `${prefix} ${app}: ${cls}: ${message}${where}`;
  }
  const detail = detailOf(alert);
  if (detail !== null) return `${prefix} ${app}: ${detail}`;
  const what = alert.metric ?? alert.rule.type;
  return `${prefix} ${app}: ${what} = ${formatValue(alert.value)} (threshold ${formatValue(alert.threshold)})`;
}

/** Plain-text multi-line body for channels without rich formatting. */
export function summaryLines(alert: AlertPayload): string[] {
  const lines = [
    `Rule: ${alert.rule.type}`,
    `App: ${appOf(alert)}`,
    `Severity: ${severityOf(alert)}`,
    `Status: ${statusOf(alert)}`,
    `Value: ${formatValue(alert.value)} (threshold ${formatValue(alert.threshold)})`,
    `At: ${alert.firedAt}`,
  ];
  const ex = alert.exception;
  if (ex !== undefined) {
    lines.push(`Occurrences in window: ${ex.occurrences}`);
    if (ex.statusCode !== null) lines.push(`Status code: ${ex.statusCode}`);
    if (ex.user !== null) lines.push(`User: ${ex.user}`);
  }
  if (alert.diagnosis !== undefined) {
    lines.push(`Probable cause (AI): ${alert.diagnosis.cause}`);
    lines.push(`Suggested fix: ${alert.diagnosis.fix}`);
  }
  const link = linkOf(alert);
  if (link !== null) lines.push(`Open in Telescope: ${link}`);
  return lines;
}

/** Deep link to the dashboard (the entry, when the alert carries one), or `null`. */
export function linkOf(alert: AlertPayload): string | null {
  if (alert.dashboardUrl === undefined) return null;
  const base = alert.dashboardUrl.replace(/\/+$/, '');
  if (alert.exception !== undefined) return `${base}#/entries/view/${alert.exception.entryId}`;
  return base;
}

/**
 * Structured details for providers with a free-form `details` field: everything
 * the payload carries except the stack (sent separately, clipped).
 */
export function detailsOf(alert: AlertPayload): Record<string, unknown> {
  const details: Record<string, unknown> = {
    rule: alert.rule.type,
    app: appOf(alert),
    instance: alert.instanceId,
    severity: severityOf(alert),
    status: statusOf(alert),
    value: alert.value,
    threshold: alert.threshold,
    firedAt: alert.firedAt,
  };
  if (alert.metric !== undefined) details.metric = alert.metric;
  const ex = alert.exception;
  if (ex !== undefined) {
    details.exception = ex.class;
    details.message = ex.message;
    details.route = ex.route;
    details.method = ex.method;
    details.statusCode = ex.statusCode;
    details.occurrences = ex.occurrences;
    details.familyHash = ex.familyHash;
    if (ex.user !== null) details.user = ex.user;
    if (ex.stack !== null) details.stack = clip(ex.stack, 2000);
  }
  if (alert.diagnosis !== undefined) details.diagnosis = alert.diagnosis;
  const link = linkOf(alert);
  if (link !== null) details.link = link;
  return details;
}

/** Clip `text` to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Options every built-in integration channel accepts. */
export interface ChannelRouting {
  /** Channel name used for per-rule routing and failure logs. Defaults to the type. */
  name?: string;
  /** Only alerts at or above this severity reach the channel. Default: all. */
  minSeverity?: AlertSeverity;
}

/**
 * Whether `channel` should receive `alert`: the rule's `channels` list (when set)
 * must name it, and the alert must meet the channel's `minSeverity`.
 */
export function routesTo(alert: AlertPayload, channel: AlertChannel): boolean {
  const rule = alert.rule as AlertRule & { channels?: string[] };
  if (Array.isArray(rule.channels) && !rule.channels.includes(channel.name)) return false;
  if (channel.minSeverity !== undefined && !meetsSeverity(severityOf(alert), channel.minSeverity)) {
    return false;
  }
  return true;
}
