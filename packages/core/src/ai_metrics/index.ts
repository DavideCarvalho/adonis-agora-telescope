/**
 * AI usage and agent run observability: pure readers for the `agora:agent:*` events, the metric
 * table both exporters (Prometheus scrape, OTLP) read, the in-process Prometheus registry, and the
 * AI screen's summarizer. The OTLP exporter (`otel_metrics_exporter.ts`) is intentionally NOT
 * re-exported: it is loaded lazily by the provider so importing this never pulls in OTel.
 */
export {
  AGENT_CHANNEL_PREFIX,
  AGENT_METRIC_EVENTS,
  type AgentMetricEvent,
  type AgentObservation,
  agentEventOfEntry,
  type CostSource,
  PLATFORM_ACTOR_REF,
  type RunObservation,
  type RunStatus,
  readAgentEvent,
  readRun,
  readUsage,
  type StepTiming,
  type ToolTiming,
  type UsageObservation,
} from './agent_events.js';
export {
  AGENT_METRIC_BUCKETS_MS,
  AGENT_METRICS,
  type AgentMetricKey,
  AgentMetricsRegistry,
  type AgentMetricsRegistryOptions,
  agentMetricPoints,
  type MetricAttributes,
  type MetricPoint,
} from './agent_metrics.js';
export {
  type AiCoverage,
  type AiRunRow,
  type AiSpend,
  type AiSpendBucket,
  type AiSpendRow,
  type AiUnpricedRow,
  type AiUsageSummary,
  type SummarizeAiUsageOptions,
  summarizeAiUsage,
} from './ai_usage.js';
export { type AgentObservationListener, subscribeAgentObservations } from './subscribe.js';
