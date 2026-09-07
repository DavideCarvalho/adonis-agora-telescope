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
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
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
 * Deliberately minimal: `BasicTracerProvider`/`LoggerProvider` from `sdk-trace-base`
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
 * Build the OTel exporter from resolved config. Each call constructs its own
 * private `BasicTracerProvider` + `LoggerProvider` (with a `BatchSpanProcessor` /
 * `BatchLogRecordProcessor` batching to the configured OTLP/HTTP endpoint) — cheap
 * enough to build once at provider boot and reuse for the process lifetime.
 */
export function createOtelExporter(config: ResolvedOtelConfig): OtelExporter {
  const resource = resourceFromAttributes({ 'service.name': config.serviceName });

  const traceExporter = new OTLPTraceExporter({
    url: `${config.endpoint}${config.tracesPath}`,
    headers: config.headers,
    timeoutMillis: config.timeoutMs,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
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
