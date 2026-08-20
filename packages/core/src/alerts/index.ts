/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.8.4';

// — channels —
export {
  consoleChannel,
  customChannel,
  slackChannel,
  webhookChannel,
} from './alert_channel.js';
export type { AlertChannel, ChannelFetch, ConsoleSink } from './alert_channel.js';

// — slack formatting —
export { formatSlackMessage } from './slack_format.js';
export type { SlackChannelOptions, SlackMessage } from './slack_format.js';

// — rules / payload —
export type {
  AlertDiagnosis,
  AlertGeoLocation,
  AlertMetric,
  AlertPayload,
  AlertRule,
  ExceptionAlertContext,
  GeoLookup,
  ResolvedAlerts,
} from './alert_rule.js';

// — new-exception dedupe —
export { DEFAULT_MAX_FAMILIES, NewExceptionTracker } from './new_exception_tracker.js';

// — alerter (exception source → tracker → channels) —
export { Alerter } from './alerter.js';
export type { AlerterDeps } from './alerter.js';

// — alerter service (interval metric-threshold rules with raise/resolve) —
export { AlerterService } from './alerter_service.js';
export type { AlerterServiceDeps, MetricSource } from './alerter_service.js';

// — exception source (the polling hook) —
export { ExceptionPoller } from './exception_source.js';
export type { ExceptionPollerDeps } from './exception_source.js';

// — duration helper —
export { durationToMs } from './parse_duration.js';

// — config —
export { DEFAULT_RULES, defineConfig, resolveConfig } from './define_config.js';
export type {
  ChannelConfig,
  ChannelSpec,
  TelescopeAlertsConfig,
} from './define_config.js';
