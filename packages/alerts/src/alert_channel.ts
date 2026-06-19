import type { AlertPayload } from './alert_rule.js';
import { type SlackChannelOptions, formatSlackMessage } from './slack_format.js';

/**
 * A delivery destination for a fired alert. An alert fans out to EVERY configured
 * channel concurrently, and a single channel failing NEVER blocks the others (the
 * {@link Alerter} isolates and warn-logs failures per channel). Implementations
 * may reject freely — the alerter catches it; the contract is simply "deliver this
 * payload, or reject, and we'll log it".
 *
 * `name` is a stable, human-readable identifier used only for rate-limited failure
 * logging (e.g. `"slack"`, `"webhook"`, `"console"`) so an operator can tell WHICH
 * destination is failing without leaking its URL.
 */
export interface AlertChannel {
  /** Stable identifier for failure logging (never the raw URL/secret). */
  name: string;
  /** Deliver the payload. Rejecting is fine — the alerter isolates + logs it. */
  send(alert: AlertPayload): Promise<void>;
}

/**
 * POST timeout for the built-in HTTP channels. A hung endpoint must never stall
 * the alerter's fan-out, so every request is raced against an abort timer.
 */
const HTTP_CHANNEL_TIMEOUT_MS = 5_000;

/**
 * Injectable `fetch` seam so tests can drive the HTTP channels deterministically
 * without a real network. Mirrors the subset of `fetch` the channels use.
 */
export type ChannelFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<unknown>;

/**
 * POST a JSON body to `url` with a hard abort timeout. Shared by the webhook and
 * Slack channels — the ONLY difference between them is the body shape, so the
 * transport lives here once. Rejects on network error / timeout / non-2xx; the
 * alerter turns that rejection into a rate-limited warn.
 */
async function postJson(fetchImpl: ChannelFetch, url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_CHANNEL_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // A real `fetch` resolves even on a 4xx/5xx; surface those as failures so a
    // misconfigured webhook is warn-logged rather than silently swallowed. Test
    // doubles that resolve `undefined` are treated as success.
    if (
      response !== undefined &&
      response !== null &&
      typeof response === 'object' &&
      'ok' in response &&
      (response as { ok: unknown }).ok === false
    ) {
      const status = 'status' in response ? (response as { status: unknown }).status : 'unknown';
      throw new Error(`HTTP ${String(status)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generic JSON webhook channel — POSTs the {@link AlertPayload} as-is so any relay
 * that parses the raw body works.
 *
 * @param url Destination that receives `POST <AlertPayload as JSON>`.
 * @param fetchImpl Test seam; defaults to global `fetch`.
 */
export function webhookChannel(url: string, fetchImpl?: ChannelFetch): AlertChannel {
  const send: ChannelFetch = fetchImpl ?? ((u, init) => fetch(u, init));
  return {
    name: 'webhook',
    send(alert: AlertPayload): Promise<void> {
      return postJson(send, url, alert);
    },
  };
}

/**
 * Slack-formatted channel — POSTs Block Kit JSON to a Slack incoming webhook so
 * the message renders as a rich card (severity header, fielded context, a
 * truncated stack snippet, and a deep link to the dashboard entry when
 * `dashboardUrl` is configured) instead of a raw JSON blob.
 *
 * @param url Slack incoming webhook URL.
 * @param options Formatting knobs (`username`/`iconEmoji` overrides).
 * @param fetchImpl Test seam; defaults to global `fetch`.
 */
export function slackChannel(
  url: string,
  options?: SlackChannelOptions,
  fetchImpl?: ChannelFetch,
): AlertChannel {
  const send: ChannelFetch = fetchImpl ?? ((u, init) => fetch(u, init));
  return {
    name: 'slack',
    send(alert: AlertPayload): Promise<void> {
      return postJson(send, url, formatSlackMessage(alert, options));
    },
  };
}

/** The sink a {@link consoleChannel} writes a one-line summary to. */
export type ConsoleSink = (message: string) => void;

/** One-line human summary of an alert for the console channel. */
function summarize(alert: AlertPayload): string {
  const base = `[telescope-alert] ${alert.rule.type} on ${alert.instanceId}`;
  if (alert.exception !== undefined) {
    const { class: cls, message, route, occurrences } = alert.exception;
    const where = route !== null ? ` (${route})` : '';
    return `${base}: ${cls}: ${message}${where} — ${occurrences}× in window`;
  }
  return `${base}: value ${alert.value} (threshold ${alert.threshold})`;
}

/**
 * Console channel — logs a one-line summary of each alert. The zero-config default
 * destination: useful in development and as a safety net so an alert is never
 * silently dropped when no remote channel is configured.
 *
 * @param sink Where to write; defaults to `console.warn`.
 */
export function consoleChannel(sink?: ConsoleSink): AlertChannel {
  const write: ConsoleSink = sink ?? ((message) => console.warn(message));
  return {
    name: 'console',
    send(alert: AlertPayload): Promise<void> {
      write(summarize(alert));
      return Promise.resolve();
    },
  };
}

/**
 * Custom channel — the escape hatch. The host supplies an arbitrary async sink
 * (send an email, publish to SNS, page someone, …) and Telescope calls it with the
 * rich {@link AlertPayload}. As with every channel, a rejection is isolated and
 * logged by the alerter, so the host's `fn` may freely throw.
 *
 * @param fn Async sink invoked with the fired alert payload.
 * @param name Identifier for failure logging. Defaults to `"custom"`.
 */
export function customChannel(
  fn: (alert: AlertPayload) => Promise<void>,
  name = 'custom',
): AlertChannel {
  return { name, send: fn };
}
