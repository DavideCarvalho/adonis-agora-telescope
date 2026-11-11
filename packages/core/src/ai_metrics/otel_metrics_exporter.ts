import type { Counter, Histogram } from '@opentelemetry/api';
import type { AgentObservation } from './agent_events.js';
import {
  AGENT_METRIC_BUCKETS_MS,
  AGENT_METRICS,
  type AgentMetricKey,
  agentMetricPoints,
} from './agent_metrics.js';
import { subscribeAgentObservations } from './subscribe.js';

/**
 * The AI-usage and agent-run instruments of {@link AGENT_METRICS}, recorded on the app's
 * GLOBAL meter provider — the one `@adonisjs/otel` builds from `config/otel.ts`, which decides
 * where (and whether) metrics are exported.
 *
 * Loaded only through the dynamic `import()` in `telescope_provider.ts`, once an OpenTelemetry
 * SDK is registered and `otel.metrics` is not `false`.
 *
 * Fed from the `agora:agent:*` diagnostics channels directly (see `subscribe.ts`), not from stored
 * entries: sampling, retention and the overload guard never change a count.
 *
 * Instruments are created with an EMPTY unit on purpose (the unit is in the name): Prometheus'
 * OTLP translation appends a unit suffix (`ms` → `_milliseconds`), which would make a metric read
 * `agora_agent_run_duration_ms_milliseconds` through a Collector but `agora_agent_run_duration_ms`
 * from the scrape endpoint. With no unit both paths expose the same series, so one Grafana
 * dashboard serves both.
 */

/** The meter surface this exporter uses. */
export interface MeterLike {
  createCounter(name: string, options?: { description?: string; unit?: string }): Counter;
  createHistogram(
    name: string,
    options?: {
      description?: string;
      unit?: string;
      advice?: { explicitBucketBoundaries?: number[] };
    },
  ): Histogram;
}

/** Metrics being recorded; stop with {@link OtelMetricsExporter.shutdown}. */
export interface OtelMetricsExporter {
  /** Record one observation (exposed for tests and for hosts that read the events themselves). */
  observe(observation: AgentObservation): void;
  /** Unsubscribe from the agent channels. The app's SDK flushes what was recorded. */
  shutdown(): void;
}

/** Create the instruments on `meter`, then subscribe to the agent channels. */
export function createOtelMetricsExporter(meter: MeterLike): OtelMetricsExporter {
  const instruments = new Map<AgentMetricKey, Counter | Histogram>();
  for (const key of Object.keys(AGENT_METRICS) as AgentMetricKey[]) {
    const def = AGENT_METRICS[key];
    instruments.set(
      key,
      def.type === 'counter'
        ? meter.createCounter(def.name, { description: def.help, unit: '' })
        : meter.createHistogram(def.name, {
            description: def.help,
            unit: '',
            advice: { explicitBucketBoundaries: [...AGENT_METRIC_BUCKETS_MS] },
          }),
    );
  }

  const observe = (observation: AgentObservation): void => {
    for (const point of agentMetricPoints(observation)) {
      const instrument = instruments.get(point.metric);
      if (instrument === undefined) continue;
      if (AGENT_METRICS[point.metric].type === 'counter') {
        (instrument as Counter).add(point.value, point.attributes);
      } else {
        (instrument as Histogram).record(point.value, point.attributes);
      }
    }
  };

  const unsubscribe = subscribeAgentObservations(observe);

  return {
    observe,
    shutdown() {
      unsubscribe();
    },
  };
}
