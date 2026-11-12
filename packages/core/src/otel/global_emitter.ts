import {
  type Context,
  context,
  createContextKey,
  isSpanContextValid,
  logs,
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import type { LogExportInput, SpanExportInput } from './mapper.js';

/**
 * Emits telescope entries through the app's GLOBAL OpenTelemetry providers — the ones
 * `@adonisjs/otel` registers from `config/otel.ts`. Telescope configures no exporter,
 * endpoint or header of its own: whatever destinations the app set up receive these
 * spans, logs and metrics alongside the auto-instrumented ones.
 *
 * Loaded only through the dynamic `import()` in `telescope_provider.ts`, and only once an
 * OpenTelemetry SDK is registered, so an app without `@adonisjs/otel` never loads
 * `@opentelemetry/api` because of telescope.
 */

/** The instrumentation scope of everything telescope emits. The span processor skips it. */
export const TELESCOPE_INSTRUMENTATION_SCOPE = '@adonis-agora/telescope';

/**
 * Parent span id used when an entry belongs to a trace whose span is no longer active here
 * (a diagnostics event delivered from another process, say). Telescope knows the trace id
 * but not the parent span, so the span hangs off a placeholder parent inside the right trace.
 */
const SYNTHETIC_PARENT_SPAN_ID = '0000000000000001';

/** The OpenTelemetry surface the emitting store uses. */
export interface OtelEmitter {
  /** The caller's active context. Call it synchronously, before any `await`. */
  capture(): Context;
  emitSpan(input: SpanExportInput, captured: Context): void;
  emitLog(input: LogExportInput, captured: Context): void;
}

/** Pick the parent context for an entry whose trace id is `traceId`. */
function parentFor(traceId: string | null, captured: Context): Context {
  const active = trace.getSpanContext(captured);
  if (active !== undefined && isSpanContextValid(active)) {
    if (traceId === null || active.traceId === traceId) return captured;
  }
  if (traceId === null) return captured;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: SYNTHETIC_PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/** Build the emitter over the global tracer and logger. */
export function createGlobalOtelEmitter(): OtelEmitter {
  const tracer = trace.getTracer(TELESCOPE_INSTRUMENTATION_SCOPE);
  const logger = logs.getLogger(TELESCOPE_INSTRUMENTATION_SCOPE);
  return {
    capture: () => context.active(),

    emitSpan(input, captured) {
      const span = tracer.startSpan(
        input.name,
        { startTime: input.startTimeMs, kind: SpanKind.INTERNAL, attributes: input.attributes },
        parentFor(input.traceId, captured),
      );
      if (input.status === 'ERROR') {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          ...(input.errorMessage !== undefined ? { message: input.errorMessage } : {}),
        });
      }
      span.end(input.endTimeMs);
    },

    emitLog(input, captured) {
      logger.emit({
        body: input.body,
        timestamp: input.timestampMs,
        severityNumber: input.severityNumber,
        severityText: input.severityText,
        attributes: input.attributes,
        context: parentFor(input.traceId, captured),
      });
    },
  };
}

/**
 * The context key OpenTelemetry instrumentations read to skip tracing (`suppressTracing` in
 * `@opentelemetry/core`). `createContextKey` is `Symbol.for(description)`, so this is the same
 * key without depending on `@opentelemetry/core`.
 */
const SUPPRESS_TRACING_KEY = createContextKey('OpenTelemetry SDK Context Key SUPPRESS_TRACING');

/** Run `fn` with tracing suppressed, so telescope's own storage queries make no spans. */
export function withoutTracing<T>(fn: () => T): T {
  return context.with(context.active().setValue(SUPPRESS_TRACING_KEY, true), fn);
}

/** Reads the trace id of the active span, for telescope's own entries. */
export function readActiveOtelTraceId(): string | undefined {
  const spanContext = trace.getSpanContext(context.active());
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
}

/** The global meter telescope's AI-usage metrics are recorded on. */
export function globalTelescopeMeter() {
  return metrics.getMeter(TELESCOPE_INSTRUMENTATION_SCOPE);
}
