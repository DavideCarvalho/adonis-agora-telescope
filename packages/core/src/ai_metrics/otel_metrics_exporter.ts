import type { Counter, Histogram } from '@opentelemetry/api';
import type { ResolvedOtelMetricsConfig } from '../define_config.js';
import type { AgentObservation } from './agent_events.js';
import {
  AGENT_METRIC_BUCKETS_MS,
  AGENT_METRICS,
  type AgentMetricKey,
  agentMetricPoints,
} from './agent_metrics.js';
import { subscribeAgentObservations } from './subscribe.js';

/**
 * The OTLP METRICS signal: the AI-usage and agent-run instruments of {@link AGENT_METRICS}, pushed
 * over OTLP/HTTP by a periodic reader.
 *
 * Loaded ONLY through the dynamic `import()` in `telescope_provider.ts`, and only when
 * `otel.metrics.enabled` is `true`; the `@opentelemetry/*` metrics packages are imported lazily
 * inside {@link loadOtelMetricsSdk}, so a host that never opts in never needs them installed.
 *
 * Like the traces/logs bridge it owns a PRIVATE `MeterProvider` and never calls
 * `metrics.setGlobalMeterProvider`, so it cannot clash with a host's own OTel setup.
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

/** The meter-provider surface this exporter uses. */
export interface MeterProviderLike {
  getMeter(name: string): {
    createCounter(name: string, options?: { description?: string; unit?: string }): Counter;
    createHistogram(
      name: string,
      options?: {
        description?: string;
        unit?: string;
        advice?: { explicitBucketBoundaries?: number[] };
      },
    ): Histogram;
  };
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Builds the provider from the resolved config. Injectable for tests. */
export type MeterProviderFactory = (
  config: ResolvedOtelMetricsConfig,
) => Promise<MeterProviderLike>;

/** Import the OTel metrics SDK and build a provider exporting to `config.url`. */
export const loadOtelMetricsSdk: MeterProviderFactory = async (config) => {
  const [sdk, exporterPkg, resources] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  const exporter = new exporterPkg.OTLPMetricExporter({
    url: config.url,
    headers: config.headers,
    timeoutMillis: config.timeoutMs,
  });
  const reader = new sdk.PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: config.exportIntervalMs,
    exportTimeoutMillis: Math.min(config.timeoutMs, config.exportIntervalMs),
  });
  return new sdk.MeterProvider({
    resource: resources.resourceFromAttributes({ 'service.name': config.serviceName }),
    readers: [reader],
  });
};

/** A running OTLP metrics export; stop it with {@link OtelMetricsExporter.shutdown}. */
export interface OtelMetricsExporter {
  /** Record one observation (exposed for tests and for hosts that read the events themselves). */
  observe(observation: AgentObservation): void;
  /** Push whatever is pending now. */
  flush(): Promise<void>;
  /** Unsubscribe, flush the tail and shut the provider down. */
  shutdown(): Promise<void>;
}

/**
 * Build the provider and its instruments, then subscribe to the agent channels. Rejects when the
 * OTel packages cannot be loaded; the provider logs that and leaves metrics export off.
 */
export async function createOtelMetricsExporter(
  config: ResolvedOtelMetricsConfig,
  factory: MeterProviderFactory = loadOtelMetricsSdk,
): Promise<OtelMetricsExporter> {
  const provider = await factory(config);
  const meter = provider.getMeter('@adonis-agora/telescope');
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
    flush: () => provider.forceFlush(),
    async shutdown() {
      unsubscribe();
      await provider.shutdown().catch(() => undefined);
    },
  };
}
