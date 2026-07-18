import {
  type AlertChannel,
  consoleChannel,
  slackChannel,
  webhookChannel,
} from './alert_channel.js';
import type { AlertRule, GeoLookup, ResolvedAlerts } from './alert_rule.js';
import { durationToMs } from './parse_duration.js';
import type { SlackChannelOptions } from './slack_format.js';

const DEFAULT_INTERVAL = '30s';
const DEFAULT_COOLDOWN = '15m';
const DEFAULT_INSTANCE_ID = 'telescope';

/**
 * A declarative channel descriptor — the JSON-friendly form usable directly in
 * `config/telescope_alerts.ts`. Resolved into a runtime {@link AlertChannel} by
 * {@link resolveConfig}. For anything custom (email, PagerDuty, …), pass a
 * pre-built `AlertChannel` object instead (the union below accepts both).
 */
export type ChannelSpec =
  | { type: 'slack'; url: string; options?: SlackChannelOptions }
  | { type: 'webhook'; url: string }
  | { type: 'console' };

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

/** Resolve one declarative spec (or pass-through object) to an {@link AlertChannel}. */
function resolveChannel(config: ChannelConfig): AlertChannel {
  if (isChannel(config)) return config;
  switch (config.type) {
    case 'slack':
      return slackChannel(config.url, config.options);
    case 'webhook':
      return webhookChannel(config.url);
    case 'console':
      return consoleChannel();
  }
}

/**
 * Validate + normalize a (possibly partial) config into the {@link ResolvedAlerts}
 * the {@link Alerter} acts on. Durations are normalized to ms (an unparseable one
 * throws — fail closed at boot). With no channels configured a `console` channel
 * is used so an alert is never silently dropped.
 */
export function resolveConfig(config: TelescopeAlertsConfig = {}): ResolvedAlerts {
  const channels: AlertChannel[] = (config.channels ?? [{ type: 'console' }]).map(resolveChannel);
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
  };
}
