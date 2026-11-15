import type { AlertChannel } from '../alert_channel.js';
import type { AlertPayload, AlertSeverity } from '../alert_rule.js';
import { deliver, type HttpDeps } from './http.js';
import {
  appOf,
  type ChannelRouting,
  clip,
  detailsOf,
  incidentKey,
  linkOf,
  severityOf,
  statusOf,
  summaryLines,
  titleOf,
} from './incident.js';

/**
 * Paging / on-call channels. Each keeps the firing → resolved lifecycle: a
 * `metric-threshold` alert (or any rule that resolves) triggers an incident and
 * later resolves the SAME incident, keyed by {@link incidentKey} (one key per
 * rule + app). Exception rules only fire; resolve those in the provider.
 */

/** Options shared by every on-call channel: routing plus retry/timeout knobs. */
export interface OnCallOptions extends ChannelRouting, HttpDeps {}

function channel(
  type: string,
  options: OnCallOptions,
  send: (alert: AlertPayload) => Promise<void>,
): AlertChannel {
  return {
    name: options.name ?? type,
    ...(options.minSeverity !== undefined ? { minSeverity: options.minSeverity } : {}),
    send,
  };
}

// ---------------------------------------------------------------------------
// PagerDuty — Events API v2
// ---------------------------------------------------------------------------

export interface PagerDutyOptions extends OnCallOptions {
  /** Integration (routing) key of an Events API v2 integration. */
  routingKey: string;
  /** Events endpoint. Default `https://events.pagerduty.com/v2/enqueue` (EU: `events.eu.pagerduty.com`). */
  url?: string;
  /** `payload.source`. Default: the alert's app. */
  source?: string;
  /** `payload.component`. */
  component?: string;
  /** `payload.group`. */
  group?: string;
}

/** Telescope severity → PagerDuty severity (same four names). */
const PAGERDUTY_SEVERITY: Record<AlertSeverity, string> = {
  critical: 'critical',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** The Events API v2 body for an alert. */
export function pagerDutyEvent(
  alert: AlertPayload,
  options: Pick<PagerDutyOptions, 'routingKey' | 'source' | 'component' | 'group'>,
): Record<string, unknown> {
  const dedupKey = incidentKey(alert);
  if (statusOf(alert) === 'resolved') {
    return { routing_key: options.routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  const link = linkOf(alert);
  return {
    routing_key: options.routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: clip(titleOf(alert), 1024),
      source: options.source ?? appOf(alert),
      severity: PAGERDUTY_SEVERITY[severityOf(alert)],
      timestamp: alert.firedAt,
      ...(options.component !== undefined ? { component: options.component } : {}),
      ...(options.group !== undefined ? { group: options.group } : {}),
      class: alert.exception?.class ?? alert.metric ?? alert.rule.type,
      custom_details: detailsOf(alert),
    },
    ...(link !== null ? { links: [{ href: link, text: 'Open in Telescope' }] } : {}),
    client: 'Telescope',
  };
}

/**
 * PagerDuty via Events API v2: `trigger` on firing, `resolve` on resolved, both
 * with `dedup_key` = {@link incidentKey}, so a repeat trigger joins the open incident.
 */
export function pagerDutyChannel(options: PagerDutyOptions): AlertChannel {
  const url = options.url ?? 'https://events.pagerduty.com/v2/enqueue';
  return channel('pagerduty', options, async (alert) => {
    await deliver({ url, body: pagerDutyEvent(alert, options) }, options);
  });
}

// ---------------------------------------------------------------------------
// Opsgenie — Alert API
// ---------------------------------------------------------------------------

export interface OpsgenieOptions extends OnCallOptions {
  /** API key of an API integration (sent as `Authorization: GenieKey …`). */
  apiKey: string;
  /** `'us'` (default) or `'eu'` — picks `api.opsgenie.com` / `api.eu.opsgenie.com`. */
  region?: 'us' | 'eu';
  /** Responders, e.g. `[{ type: 'team', name: 'backend' }]`. */
  responders?: Array<{ type: 'team' | 'user' | 'escalation' | 'schedule'; name: string }>;
  /** Extra tags. `telescope` and the severity are always added. */
  tags?: string[];
}

const OPSGENIE_PRIORITY: Record<AlertSeverity, string> = {
  critical: 'P1',
  error: 'P2',
  warning: 'P3',
  info: 'P5',
};

/** The create-alert body for an alert. */
export function opsgenieAlert(
  alert: AlertPayload,
  options: Pick<OpsgenieOptions, 'responders' | 'tags'> = {},
): Record<string, unknown> {
  const severity = severityOf(alert);
  return {
    message: clip(titleOf(alert), 130),
    alias: clip(incidentKey(alert), 512),
    description: clip(summaryLines(alert).join('\n'), 15000),
    priority: OPSGENIE_PRIORITY[severity],
    source: 'Telescope',
    entity: appOf(alert),
    tags: ['telescope', severity, ...(options.tags ?? [])],
    details: Object.fromEntries(
      Object.entries(detailsOf(alert)).map(([k, v]) => [
        k,
        clip(typeof v === 'string' ? v : JSON.stringify(v), 8000),
      ]),
    ),
    ...(options.responders !== undefined ? { responders: options.responders } : {}),
  };
}

/**
 * Opsgenie: creates an alert with `alias` = {@link incidentKey} (Opsgenie folds
 * repeats into the open alert) and closes it by alias on resolve.
 */
export function opsgenieChannel(options: OpsgenieOptions): AlertChannel {
  const base = options.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com';
  const headers = { authorization: `GenieKey ${options.apiKey}` };
  return channel('opsgenie', options, async (alert) => {
    if (statusOf(alert) === 'resolved') {
      const alias = encodeURIComponent(clip(incidentKey(alert), 512));
      await deliver(
        {
          url: `${base}/v2/alerts/${alias}/close?identifierType=alias`,
          headers,
          body: { source: 'Telescope', note: `Resolved at ${alert.firedAt}` },
        },
        options,
      );
      return;
    }
    await deliver(
      { url: `${base}/v2/alerts`, headers, body: opsgenieAlert(alert, options) },
      options,
    );
  });
}

// ---------------------------------------------------------------------------
// Better Stack — Uptime incidents API
// ---------------------------------------------------------------------------

export interface BetterStackIncidentOptions extends OnCallOptions {
  /** Better Stack Uptime API token. */
  apiToken: string;
  /** Email shown as the incident's requester. Required by Better Stack. */
  requesterEmail: string;
  /** Escalate to this team. */
  teamName?: string;
  /** API base. Default `https://uptime.betterstack.com`. */
  baseUrl?: string;
  /**
   * Which notification methods to use. Default: email + push always, call + SMS
   * for `critical` alerts.
   */
  notify?: (severity: AlertSeverity) => {
    call: boolean;
    sms: boolean;
    email: boolean;
    push: boolean;
  };
  /** Cap on incidents remembered for resolving. Default `1000`. */
  maxOpen?: number;
}

/** The create-incident body for an alert. */
export function betterStackIncident(
  alert: AlertPayload,
  options: Pick<BetterStackIncidentOptions, 'requesterEmail' | 'teamName' | 'notify'>,
): Record<string, unknown> {
  const severity = severityOf(alert);
  const notify =
    options.notify?.(severity) ??
    (severity === 'critical'
      ? { call: true, sms: true, email: true, push: true }
      : { call: false, sms: false, email: true, push: true });
  return {
    requester_email: options.requesterEmail,
    name: clip(titleOf(alert), 255),
    summary: clip(titleOf(alert), 255),
    description: summaryLines(alert).join('\n'),
    ...notify,
    ...(options.teamName !== undefined ? { team_name: options.teamName } : {}),
  };
}

function readIncidentId(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const data = (json as { data?: { id?: unknown } }).data;
  const id = data?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/**
 * Better Stack Uptime: creates an incident on firing and resolves it on resolved.
 * Better Stack has no dedup key, so the channel remembers the open incident per
 * {@link incidentKey} and does not create a second one while it is open. The
 * memory is per process: after a restart, an open incident is resolved by hand.
 */
export function betterStackIncidentChannel(options: BetterStackIncidentOptions): AlertChannel {
  const base = (options.baseUrl ?? 'https://uptime.betterstack.com').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.apiToken}` };
  const maxOpen = options.maxOpen ?? 1000;
  const open = new Map<string, string>();
  const pending = new Set<string>();
  return channel('betterstack', options, async (alert) => {
    const key = incidentKey(alert);
    if (statusOf(alert) === 'resolved') {
      const id = open.get(key);
      if (id === undefined) return;
      await deliver(
        {
          url: `${base}/api/v2/incidents/${encodeURIComponent(id)}/resolve`,
          headers,
          body: { resolved_by: 'Telescope' },
        },
        options,
      );
      open.delete(key);
      return;
    }
    if (open.has(key) || pending.has(key)) return;
    pending.add(key);
    try {
      const result = await deliver(
        { url: `${base}/api/v2/incidents`, headers, body: betterStackIncident(alert, options) },
        options,
      );
      const id = readIncidentId(result.json);
      if (id !== null) {
        if (open.size >= maxOpen) {
          const oldest = open.keys().next().value;
          if (oldest !== undefined) open.delete(oldest);
        }
        open.set(key, id);
      }
    } finally {
      pending.delete(key);
    }
  });
}

// ---------------------------------------------------------------------------
// incident.io — Alert events v2 (HTTP alert source)
// ---------------------------------------------------------------------------

export interface IncidentIoOptions extends OnCallOptions {
  /** The HTTP alert source's config id (the last path segment of its URL). */
  alertSourceConfigId: string;
  /** The alert source's bearer token. */
  token: string;
  /** API base. Default `https://api.incident.io`. */
  baseUrl?: string;
}

/** The alert-event body for an alert. */
export function incidentIoEvent(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  return {
    title: clip(titleOf(alert), 255),
    description: summaryLines(alert).join('\n'),
    deduplication_key: incidentKey(alert),
    status: statusOf(alert),
    ...(link !== null ? { source_url: link } : {}),
    metadata: detailsOf(alert),
  };
}

/** incident.io: `status: firing|resolved` with `deduplication_key` = {@link incidentKey}. */
export function incidentIoChannel(options: IncidentIoOptions): AlertChannel {
  const base = (options.baseUrl ?? 'https://api.incident.io').replace(/\/+$/, '');
  const url = `${base}/v2/alert_events/http/${encodeURIComponent(options.alertSourceConfigId)}`;
  const headers = { authorization: `Bearer ${options.token}` };
  return channel('incident-io', options, async (alert) => {
    await deliver({ url, headers, body: incidentIoEvent(alert) }, options);
  });
}

// ---------------------------------------------------------------------------
// Grafana OnCall — formatted webhook integration
// ---------------------------------------------------------------------------

export interface GrafanaOnCallOptions extends OnCallOptions {
  /** The integration's webhook URL (it carries the integration token). */
  url: string;
}

/** The formatted-webhook body for an alert. */
export function grafanaOnCallEvent(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  return {
    alert_uid: incidentKey(alert),
    title: titleOf(alert),
    state: statusOf(alert) === 'resolved' ? 'ok' : 'alerting',
    message: summaryLines(alert).join('\n'),
    ...(link !== null ? { link_to_upstream_details: link } : {}),
    severity: severityOf(alert),
  };
}

/** Grafana OnCall: `state: alerting|ok` grouped by `alert_uid` = {@link incidentKey}. */
export function grafanaOnCallChannel(options: GrafanaOnCallOptions): AlertChannel {
  return channel('grafana-oncall', options, async (alert) => {
    await deliver({ url: options.url, body: grafanaOnCallEvent(alert) }, options);
  });
}
