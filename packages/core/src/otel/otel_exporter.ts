import {
  type Context,
  context as otelContext,
  trace as otelTrace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import type { BatchSpanProcessor, SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ResolvedOtelConfig } from '../define_config.js';
import type { LogExportInput, SpanExportInput } from './mapper.js';

/**
 * THE ONLY FILE in this package that imports `@opentelemetry/*` at the module
 * top level. It is loaded exclusively via a dynamic `import()` from
 * `telescope_provider.ts`'s `applyOtel`, and ONLY when `config.otel.enabled` is
 * `true` — so a host who never turns this on never pays for (or needs to install)
 * any OTel package. Mirrors the exact convention `stores/factory.ts` uses for the
 * `lucid` driver's peer dependency.
 *
 * Deliberately minimal: `TracerProvider`/`LoggerProvider` from `sdk-trace`
 * / `sdk-logs` plus their OTLP/HTTP exporters — no auto-instrumentation SDK, no
 * Node context-manager registration, no global provider registration
 * (`trace.setGlobalTracerProvider` is never called). This bridge owns a PRIVATE
 * tracer/logger pair and reads span context explicitly per call — it never
 * touches (or conflicts with) a host's own OTel setup (e.g. `@adonisjs/otel`),
 * which may already have its own global provider wired for live request tracing.
 */

/** A non-existent parent span id used to synthesize a "remote parent" `SpanContext`
 *  carrying only a known trace id (see the module doc on `mapper.ts` for why: telescope
 *  only ever learns a trace ID, never a real parent span id, for an already-finished
 *  diagnostics event). Any valid (non-all-zero) 16-hex value works — Tempo/Grafana group
 *  by trace id, so this never needs to resolve to a real span. */
const SYNTHETIC_PARENT_SPAN_ID = '0000000000000001';

/** What `telescope_otel_exporting_store.ts` calls per mapped entry. */
export interface OtelExporter {
  exportSpan(input: SpanExportInput): void;
  exportLog(input: LogExportInput): void;
  /** Flush + shut down both providers. Called at telescope provider shutdown. */
  shutdown(): Promise<void>;
}

/** Build the `Context` carrying a synthesized remote-parent `SpanContext` for `traceId`. */
function contextFor(traceId: string | null): Context | undefined {
  if (traceId === null) return undefined;
  return otelTrace.setSpanContext(otelContext.active(), {
    traceId,
    spanId: SYNTHETIC_PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/**
 * The slice of the tracing SDK this bridge needs, normalized across the two packages
 * that can provide it (see {@link loadTraceSdk}).
 */
export interface TraceSdk {
  TracerProvider: typeof TracerProvider;
  /** Wrap `exporter` in a `BatchSpanProcessor`, in whichever constructor shape the
   *  resolved package takes. */
  createBatchSpanProcessor(exporter: SpanExporter): BatchSpanProcessor;
}

/** How {@link loadTraceSdk} imports each candidate package. Injectable for tests. */
export interface TraceSdkLoaders {
  sdkTrace: () => Promise<
    Pick<typeof import('@opentelemetry/sdk-trace'), 'TracerProvider' | 'BatchSpanProcessor'>
  >;
  sdkTraceBase: () => Promise<
    Pick<
      typeof import('@opentelemetry/sdk-trace-base'),
      'BasicTracerProvider' | 'BatchSpanProcessor'
    >
  >;
}

const defaultTraceSdkLoaders: TraceSdkLoaders = {
  sdkTrace: () => import('@opentelemetry/sdk-trace'),
  sdkTraceBase: () => import('@opentelemetry/sdk-trace-base'),
};

/**
 * Resolve the tracing SDK. OTel JS 3 retired `@opentelemetry/sdk-trace-base`: its last
 * line is 2.x, deprecated in favour of `@opentelemetry/sdk-trace`, which ships from 2.9.0
 * on. The two differ in exactly the two classes used here:
 *
 * | package                         | provider class        | `BatchSpanProcessor` takes  |
 * | ------------------------------- | --------------------- | --------------------------- |
 * | `@opentelemetry/sdk-trace` 2.9+ | `TracerProvider`      | `{ exporter, ...options }`  |
 * | `@opentelemetry/sdk-trace-base` | `BasicTracerProvider` | `(exporter, config?)`       |
 *
 * Both providers take the same `{ resource, spanProcessors }` options. Order:
 *
 * 1. `@opentelemetry/sdk-trace` (2.9+ or 3.x) when the host has it;
 * 2. otherwise `@opentelemetry/sdk-trace-base` 2.x, the package this bridge required
 *    before, so a host that installed only that keeps exporting after upgrading.
 *
 * When neither loads, the error from `sdk-trace` (the package the docs tell hosts to
 * install) is rethrown, and the provider logs it and leaves OTel export off.
 */
export async function loadTraceSdk(
  loaders: TraceSdkLoaders = defaultTraceSdkLoaders,
): Promise<TraceSdk> {
  try {
    const sdk = await loaders.sdkTrace();
    return {
      TracerProvider: sdk.TracerProvider,
      createBatchSpanProcessor: (exporter) => new sdk.BatchSpanProcessor({ exporter }),
    };
  } catch (sdkTraceError) {
    let legacy: Awaited<ReturnType<TraceSdkLoaders['sdkTraceBase']>>;
    try {
      legacy = await loaders.sdkTraceBase();
    } catch {
      throw sdkTraceError;
    }
    // The casts only bridge type identity: the legacy classes were compiled against
    // their own copies of `@opentelemetry/resources` / `api`, not the ones resolved here.
    return {
      TracerProvider: legacy.BasicTracerProvider as unknown as typeof TracerProvider,
      createBatchSpanProcessor: (exporter) =>
        new legacy.BatchSpanProcessor(exporter as never) as unknown as BatchSpanProcessor,
    };
  }
}

/**
 * Build the OTel exporter from resolved config. Each call constructs its own
 * private `TracerProvider` + `LoggerProvider` (with a `BatchSpanProcessor` /
 * `BatchLogRecordProcessor` batching to the configured OTLP/HTTP endpoint) — cheap
 * enough to build once at provider boot and reuse for the process lifetime. Async
 * only because the tracing SDK is resolved at call time (see {@link loadTraceSdk}).
 */
export async function createOtelExporter(
  config: ResolvedOtelConfig,
  traceSdkLoaders?: TraceSdkLoaders,
): Promise<OtelExporter> {
  const traceSdk = await loadTraceSdk(traceSdkLoaders);
  const resource = resourceFromAttributes({ 'service.name': config.serviceName });

  const traceExporter = new OTLPTraceExporter({
    url: `${config.endpoint}${config.tracesPath}`,
    headers: config.headers,
    timeoutMillis: config.timeoutMs,
  });
  const tracerProvider = new traceSdk.TracerProvider({
    resource,
    spanProcessors: [traceSdk.createBatchSpanProcessor(traceExporter)],
  });
  const tracer = tracerProvider.getTracer('@adonis-agora/telescope');

  const logExporter = new OTLPLogExporter({
    url: `${config.endpoint}${config.logsPath}`,
    headers: config.headers,
    timeoutMillis: config.timeoutMs,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: logExporter })],
  });
  const logger = loggerProvider.getLogger('@adonis-agora/telescope');

  return {
    exportSpan(input) {
      const span = tracer.startSpan(
        input.name,
        {
          startTime: input.startTimeMs,
          kind: SpanKind.INTERNAL,
          attributes: input.attributes,
        },
        contextFor(input.traceId) ?? otelContext.active(),
      );
      if (input.status === 'ERROR') {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          ...(input.errorMessage !== undefined ? { message: input.errorMessage } : {}),
        });
        if (input.errorMessage !== undefined) span.recordException(input.errorMessage);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(input.endTimeMs);
    },

    exportLog(input) {
      // `input.severityNumber` is already the OTel `SeverityNumber` numeric value
      // (mapper.ts documents the 9/13/17 literals it uses) — passed through
      // verbatim so this file needn't import `@opentelemetry/api-logs` at all.
      const ctx = contextFor(input.traceId);
      logger.emit({
        body: input.body,
        timestamp: input.timestampMs,
        severityNumber: input.severityNumber,
        severityText: input.severityText,
        attributes: input.attributes,
        ...(ctx !== undefined ? { context: ctx } : {}),
      });
    },

    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    },
  };
}
