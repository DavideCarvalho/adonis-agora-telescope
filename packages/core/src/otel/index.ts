/**
 * `@adonis-agora/telescope/otel` — the pieces an app wires into `@adonisjs/otel`.
 *
 * - {@link telescopeSpanProcessor}: add it to `spanProcessors` in `config/otel.ts` to see the
 *   app's OpenTelemetry spans in telescope's trace waterfall.
 * - {@link mapEntryToOtel}: how a telescope entry becomes a span or a log record when telescope
 *   emits it through the app's OpenTelemetry providers.
 *
 * Nothing here imports an `@opentelemetry/*` package, so `config/otel.ts` can load it before the
 * app boots.
 */
export {
  type AttributeMap,
  type AttributeValue,
  isValidW3cTraceId,
  type LogExportInput,
  type MappedEntry,
  mapEntryToOtel,
  resolveDurationMs,
  type SpanExportInput,
} from './mapper.js';
export {
  type ReadableSpanLike,
  type SpanEntryContent,
  type SpanKindName,
  type StartedSpanLike,
  type TelescopeSpanProcessor,
  type TelescopeSpanProcessorOptions,
  telescopeSpanProcessor,
} from './span_processor.js';
