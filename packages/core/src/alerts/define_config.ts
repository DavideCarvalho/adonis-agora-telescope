import {
  type AlertChannel,
  consoleChannel,
  slackChannel,
  webhookChannel,
} from './alert_channel.js';
import type { AlertRule, AlertSeverity, GeoLookup, ResolvedAlerts } from './alert_rule.js';
import {
  type DiscordOptions,
  discordChannel,
  type GoogleChatOptions,
  googleChatChannel,
  type TeamsOptions,
  type TelegramOptions,
  teamsChannel,
  telegramChannel,
} from './integrations/chat.js';
import { type EmailOptions, emailChannel } from './integrations/email.js';
import type { CheckStateSource } from './integrations/health.js';
import { type HeartbeatConfig, validateHeartbeat } from './integrations/heartbeats.js';
import {
  type BetterStackIncidentOptions,
  betterStackIncidentChannel,
  type GrafanaOnCallOptions,
  grafanaOnCallChannel,
  type IncidentIoOptions,
  incidentIoChannel,
  type OpsgenieOptions,
  opsgenieChannel,
  type PagerDutyOptions,
  pagerDutyChannel,
} from './integrations/on_call.js';
import { type StatusPageConfig, validateStatusPage } from './integrations/status_pages.js';
import { durationToMs } from './parse_duration.js';
import type { SlackChannelOptions } from './slack_format.js';

const DEFAULT_INTERVAL = '30s';
const DEFAULT_COOLDOWN = '15m';
const DEFAULT_INSTANCE_ID = 'telescope';

/** Test seams the declarative specs don't expose. */
type Seams = 'fetch' | 'sleep';

/**
 * Lets every field but the discriminant be `undefined`, so `env.get('KEY')`
 * (typed `string | undefined`) fits. A missing required value disables that
 * integration at boot with a warning.
 */
export type FromEnv<T> = T extends unknown
  ? { [K in keyof T]: K extends 'type' | 'provider' ? T[K] : T[K] | undefined }
  : never;

/**
 * Routing fields every declarative spec accepts: `name` (what a rule's
 * `channels` list refers to; defaults to the `type`) and `minSeverity`.
 */
export interface SpecRouting {
  name?: string;
  minSeverity?: AlertSeverity;
}

/**
 * A declarative channel descriptor — the JSON-friendly form usable directly in
 * `config/telescope_alerts.ts`. Resolved into a runtime {@link AlertChannel} by
 * {@link resolveConfig}. For anything custom, pass a pre-built `AlertChannel`
 * object instead (the union below accepts both). Secrets come from env; a spec
 * whose secret is missing is skipped at boot with a warning naming the field.
 */
export type ChannelSpec = SpecRouting &
  (
    | { type: 'slack'; url: string; options?: SlackChannelOptions }
    | { type: 'webhook'; url: string }
    | { type: 'console' }
    | ({ type: 'pagerduty' } & FromEnv<Omit<PagerDutyOptions, Seams>>)
    | ({ type: 'opsgenie' } & FromEnv<Omit<OpsgenieOptions, Seams>>)
    | ({ type: 'betterstack' } & FromEnv<Omit<BetterStackIncidentOptions, Seams>>)
    | ({ type: 'incident-io' } & FromEnv<Omit<IncidentIoOptions, Seams>>)
    | ({ type: 'grafana-oncall' } & FromEnv<Omit<GrafanaOnCallOptions, Seams>>)
    | ({ type: 'discord' } & FromEnv<Omit<DiscordOptions, Seams>>)
    | ({ type: 'teams' } & FromEnv<Omit<TeamsOptions, Seams>>)
    | ({ type: 'telegram' } & FromEnv<Omit<TelegramOptions, Seams>>)
    | ({ type: 'google-chat' } & FromEnv<Omit<GoogleChatOptions, Seams>>)
    | ({ type: 'email' } & FromEnv<Omit<EmailOptions, 'mail'>>)
  );

/** Either a declarative spec or a ready-made channel object. */
export type ChannelConfig = ChannelSpec | AlertChannel;

/**
 * The shape of `config/telescope_alerts.ts`. Everything is optional with sane
 * defaults: alerting is on, polls every 30s, fires on a brand-new exception family
 * (re-firing only after a 15m cooldown), and logs to the console channel.
 */
export interface TelescopeAlertsConfig {
  /** Master switch. When `false`, no alerting runs. Default `true`. */
  enabled?: boolean;
  /**
   * Delivery destinations. Each fired alert is sent to every channel concurrently;
   * one channel failing never blocks the others. Accepts declarative specs
   * (`{ type: 'slack', url }`) or pre-built `AlertChannel` objects. Default:
   * a single `console` channel.
   */
  channels?: ChannelConfig[];
  /**
   * Rules to evaluate. Default: a single `new-exception` rule over a 1h window.
   */
  rules?: AlertRule[];
  /**
   * External Telescope dashboard URL (e.g. `https://telescope.example.com/`). When
   * set, channels that support deep links (Slack) build a link to the offending
   * entry. Optional.
   */
  dashboardUrl?: string;
  /** Poll cadence for the exception source, as a duration string. Default `'30s'`. */
  every?: string;
  /** Re-notify suppression per rule/family, as a duration string. Default `'15m'`. */
  cooldown?: string;
  /** Reporting instance identifier carried on every payload. Default `'telescope'`. */
  instanceId?: string;
  /**
   * Optional IP→geo resolver. When set, a firing exception alert that carries a
   * `clientIp` is enriched with a coarse {@link AlertGeoLocation} (rendered as a
   * "Location" field by channels that support it). Kept out of the lib core so
   * telescope ships no geo dependency — see {@link GeoLookup}. May be sync or
   * async; a `null`/throw simply omits the Location field.
   */
  geoLookup?: GeoLookup;
  /**
   * Push uptime monitors (healthchecks.io, Better Stack, Cronitor, Uptime Kuma,
   * UptimeRobot, any URL), pinged only while the app is healthy.
   */
  heartbeats?: FromEnv<HeartbeatConfig>[];
  /** Status pages (Better Stack, Atlassian Statuspage, Instatus) kept in step with the checks. */
  statusPages?: FromEnv<StatusPageConfig>[];
  /**
   * Where heartbeats and status pages read the current check states. Defaults
   * to the check states Telescope publishes at runtime, when it has any.
   */
  checkStates?: CheckStateSource;
}

/** The default rule set — page on a brand-new exception family within the hour. */
export const DEFAULT_RULES: AlertRule[] = [{ type: 'new-exception', window: '1h' }];

/**
 * Identity helper giving `config/telescope_alerts.ts` full type-checking, mirroring
 * the AdonisJS `defineConfig` convention.
 */
export function defineConfig(config: TelescopeAlertsConfig): TelescopeAlertsConfig {
  return config;
}

/** Narrow a {@link ChannelConfig} to a ready-made {@link AlertChannel}. */
function isChannel(config: ChannelConfig): config is AlertChannel {
  return typeof (config as AlertChannel).send === 'function';
}

/** The fields each spec type can't work without (secrets usually come from env). */
const REQUIRED_FIELDS: Record<string, string[]> = {
  slack: ['url'],
  webhook: ['url'],
  console: [],
  pagerduty: ['routingKey'],
  opsgenie: ['apiKey'],
  betterstack: ['apiToken', 'requesterEmail'],
  'incident-io': ['alertSourceConfigId', 'token'],
  'grafana-oncall': ['url'],
  discord: ['url'],
  teams: ['url'],
  telegram: ['botToken', 'chatId'],
  'google-chat': ['url'],
  email: ['to'],
};

function isMissing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A spec whose required fields were checked: env-tolerant fields are now set. */
type CheckedSpec = SpecRouting &
  (
    | Extract<ChannelSpec, { type: 'slack' | 'webhook' | 'console' }>
    | ({ type: 'pagerduty' } & PagerDutyOptions)
    | ({ type: 'opsgenie' } & OpsgenieOptions)
    | ({ type: 'betterstack' } & BetterStackIncidentOptions)
    | ({ type: 'incident-io' } & IncidentIoOptions)
    | ({ type: 'grafana-oncall' } & GrafanaOnCallOptions)
    | ({ type: 'discord' } & DiscordOptions)
    | ({ type: 'teams' } & TeamsOptions)
    | ({ type: 'telegram' } & TelegramOptions)
    | ({ type: 'google-chat' } & GoogleChatOptions)
    | ({ type: 'email' } & EmailOptions)
  );

/** Build the channel for one checked spec. */
function buildChannel(config: CheckedSpec): AlertChannel {
  switch (config.type) {
    case 'slack':
      return slackChannel(config.url, config.options);
    case 'webhook':
      return webhookChannel(config.url);
    case 'console':
      return consoleChannel();
    case 'pagerduty':
      return pagerDutyChannel(config);
    case 'opsgenie':
      return opsgenieChannel(config);
    case 'betterstack':
      return betterStackIncidentChannel(config);
    case 'incident-io':
      return incidentIoChannel(config);
    case 'grafana-oncall':
      return grafanaOnCallChannel(config);
    case 'discord':
      return discordChannel(config);
    case 'teams':
      return teamsChannel(config);
    case 'telegram':
      return telegramChannel(config);
    case 'google-chat':
      return googleChatChannel(config);
    case 'email':
      return emailChannel(config);
  }
}

/**
 * Resolve one declarative spec (or pass-through object) to an {@link AlertChannel}.
 * Returns `null` (after a warning that names the field, never its value) when a
 * required field — usually an env secret — is missing.
 */
function resolveChannel(
  config: ChannelConfig,
  warn: (message: string) => void,
): AlertChannel | null {
  if (isChannel(config)) return config;
  const required = REQUIRED_FIELDS[config.type];
  if (required === undefined) {
    throw new Error(`Unknown telescope alert channel type '${String(config.type)}'`);
  }
  const missing = required.filter((field) =>
    isMissing((config as unknown as Record<string, unknown>)[field]),
  );
  if (missing.length > 0) {
    warn(
      `Telescope alert channel '${config.name ?? config.type}' is disabled: missing ${missing.join(', ')}`,
    );
    return null;
  }
  // Drop `undefined` optionals so they read as unset.
  const defined = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as unknown as CheckedSpec;
  const channel = buildChannel(defined);
  return {
    ...channel,
    name: config.name ?? channel.name,
    ...(config.minSeverity !== undefined ? { minSeverity: config.minSeverity } : {}),
  };
}

/**
 * Validate + normalize a (possibly partial) config into the {@link ResolvedAlerts}
 * the {@link Alerter} acts on. Durations are normalized to ms (an unparseable one
 * throws — fail closed at boot). With no channels configured a `console` channel
 * is used so an alert is never silently dropped.
 */
export function resolveConfig(
  config: TelescopeAlertsConfig = {},
  warn: (message: string) => void = (message) => console.warn(message),
): ResolvedAlerts {
  const channels: AlertChannel[] = (config.channels ?? [{ type: 'console' }])
    .map((channel) => resolveChannel(channel, warn))
    .filter((channel): channel is AlertChannel => channel !== null);
  const rules =
    config.rules !== undefined && config.rules.length > 0 ? config.rules : DEFAULT_RULES;

  // Validate every rule window at boot — a typo surfaces here, not silently never.
  for (const rule of rules) {
    // `every-exception`'s window is OPTIONAL (occurrence-count only); validate it
    // when present so a typo fails at boot rather than silently mis-counting.
    if (rule.type === 'every-exception') {
      if (rule.window !== undefined) durationToMs(rule.window);
      continue;
    }
    if (rule.type === 'instances-up') {
      if (!Number.isInteger(rule.below) || rule.below < 1) {
        throw new Error('instances-up: `below` must be a whole number, 1 or more');
      }
      if (rule.for !== undefined) durationToMs(rule.for);
      continue;
    }
    if (rule.type === 'restart-loop') continue;
    if (rule.type === 'check-down') {
      durationToMs(rule.for);
      continue;
    }
    if (rule.type === 'entries-dropped') {
      durationToMs(rule.window);
      if (
        rule.threshold !== undefined &&
        (!Number.isFinite(rule.threshold) || rule.threshold < 1)
      ) {
        throw new Error('entries-dropped: `threshold` must be 1 or more');
      }
      continue;
    }
    durationToMs(rule.window);
  }

  return {
    enabled: config.enabled ?? true,
    channels,
    dashboardUrl:
      typeof config.dashboardUrl === 'string' && config.dashboardUrl.trim() !== ''
        ? config.dashboardUrl
        : null,
    intervalMs: durationToMs(config.every ?? DEFAULT_INTERVAL),
    cooldownMs: durationToMs(config.cooldown ?? DEFAULT_COOLDOWN),
    instanceId: config.instanceId ?? DEFAULT_INSTANCE_ID,
    rules,
    geoLookup: typeof config.geoLookup === 'function' ? config.geoLookup : null,
    heartbeats: resolveHeartbeats(config.heartbeats ?? [], warn),
    statusPages: resolveStatusPages(config.statusPages ?? [], warn),
    checkStates: typeof config.checkStates === 'function' ? config.checkStates : null,
  };
}

/**
 * Heartbeats whose ping URL is unset (env missing) are dropped with a warning;
 * apps with an unset URL are dropped from `apps`. A bad `every` throws.
 */
function resolveHeartbeats(
  heartbeats: FromEnv<HeartbeatConfig>[],
  warn: (message: string) => void,
): HeartbeatConfig[] {
  const resolved: HeartbeatConfig[] = [];
  for (const heartbeat of heartbeats) {
    const label = heartbeat.name ?? heartbeat.provider;
    const apps: Record<string, string> = {};
    for (const [app, appUrl] of Object.entries(heartbeat.apps ?? {})) {
      if (typeof appUrl === 'string' && !isMissing(appUrl)) apps[app] = appUrl;
      else warn(`Telescope heartbeat '${label}' skips app '${app}': missing url`);
    }
    const url =
      typeof heartbeat.url === 'string' && !isMissing(heartbeat.url) ? heartbeat.url : undefined;
    if (url === undefined && Object.keys(apps).length === 0) {
      warn(`Telescope heartbeat '${label}' is disabled: missing url`);
      continue;
    }
    const { url: _url, apps: _apps, ...rest } = heartbeat;
    const next: HeartbeatConfig = {
      ...(Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      ) as Omit<HeartbeatConfig, 'url' | 'apps'>),
      ...(url !== undefined ? { url } : {}),
      ...(Object.keys(apps).length > 0 ? { apps } : {}),
    };
    validateHeartbeat(next);
    resolved.push(next);
  }
  return resolved;
}

const STATUS_PAGE_SECRETS: Record<StatusPageConfig['provider'], string[]> = {
  statuspage: ['apiKey', 'pageId'],
  instatus: ['apiKey', 'pageId'],
  betterstack: ['apiToken', 'statusPageId'],
};

/** Status pages missing their key/page id are dropped with a warning. */
function resolveStatusPages(
  pages: FromEnv<StatusPageConfig>[],
  warn: (message: string) => void,
): StatusPageConfig[] {
  const resolved: StatusPageConfig[] = [];
  for (const loose of pages) {
    const page = Object.fromEntries(
      Object.entries(loose).filter(([, value]) => value !== undefined),
    ) as unknown as StatusPageConfig;
    const missing = (STATUS_PAGE_SECRETS[page.provider] ?? []).filter((field) =>
      isMissing((page as unknown as Record<string, unknown>)[field]),
    );
    if (missing.length > 0) {
      warn(
        `Telescope status page '${page.name ?? page.provider}' is disabled: missing ${missing.join(', ')}`,
      );
      continue;
    }
    validateStatusPage(page);
    resolved.push(page);
  }
  return resolved;
}
