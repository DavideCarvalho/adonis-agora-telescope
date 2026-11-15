import { AsyncLocalStorage } from 'node:async_hooks';
import { newSpanId, newTraceId, type TraceParent } from './traceparent.js';

/**
 * The trace a unit of work (an HTTP request, a queue job) belongs to when telescope, not
 * OpenTelemetry, keeps it: the caller's trace id when there was a caller, and a span id of its own
 * that the calls it makes name as their parent.
 *
 * On a `Symbol.for()` global slot so two copies of this package share one scope.
 */
export interface TraceScope {
  /** The trace id a caller sent (`traceparent`, a job's trace context). `null`: no caller. */
  upstreamTraceId: string | null;
  /**
   * The trace id when there is no caller, no OpenTelemetry span and no `@adonis-agora/context`
   * trace id. Minted with the scope.
   */
  fallbackTraceId: string;
  /** This unit of work's span id. */
  spanId: string;
  /** The caller's span id, or `null`. */
  parentSpanId: string | null;
  /** Trace flags to forward (`01` = sampled). */
  flags: string;
  /** The caller's `tracestate`, forwarded as is. */
  tracestate?: string;
}

const SCOPE_KEY = Symbol.for('@agora/telescope:trace-scope');
const slot = globalThis as Record<symbol, unknown>;
const storage: AsyncLocalStorage<TraceScope> =
  (slot[SCOPE_KEY] as AsyncLocalStorage<TraceScope> | undefined) ??
  new AsyncLocalStorage<TraceScope>();
slot[SCOPE_KEY] = storage;

/** The storage itself, for `diagnostics_channel` `bindStore`. */
export function traceScopeStorage(): AsyncLocalStorage<TraceScope> {
  return storage;
}

/** A scope continuing `parent` (a caller), or starting a new trace. */
export function newTraceScope(parent?: TraceParent, tracestate?: string): TraceScope {
  return {
    upstreamTraceId: parent?.traceId ?? null,
    fallbackTraceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId ?? null,
    flags: parent?.flags ?? '01',
    ...(tracestate !== undefined ? { tracestate } : {}),
  };
}

/** Run `fn` inside `scope`. */
export function runInTraceScope<T>(scope: TraceScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The active scope, or `undefined`. */
export function currentTraceScope(): TraceScope | undefined {
  return storage.getStore();
}

/** The active OpenTelemetry span, as telescope reads it. */
export interface OtelSpanRef {
  traceId: string;
  spanId: string;
  /** Its parent's span id (the caller's client span, for a server span). */
  parentSpanId: string | null;
}

/** Reads the active OpenTelemetry span. Installed by the provider when OTel runs. */
export type OtelSpanReader = () => OtelSpanRef | undefined;

const OTEL_SPAN_READER = Symbol.for('@agora/telescope:otel-span-reader');

/** Install (or clear) the reader for the active OpenTelemetry span. */
export function setOtelSpanReader(reader: OtelSpanReader | null): void {
  slot[OTEL_SPAN_READER] = reader ?? undefined;
}

/** The active OpenTelemetry span, or `undefined` when OTel is off or no span is active. */
export function currentOtelSpan(): OtelSpanRef | undefined {
  const reader = slot[OTEL_SPAN_READER] as OtelSpanReader | undefined;
  if (reader === undefined) return undefined;
  try {
    return reader();
  } catch {
    return undefined;
  }
}

/**
 * Whether OpenTelemetry tracing runs in this process (a global tracer provider is registered, as
 * `@adonisjs/otel` does). When it does, its instrumentations own propagation: telescope adds no
 * header and no job trace context of its own, so nothing is injected twice.
 */
export function isOtelTracingActive(): boolean {
  const registry = slot[Symbol.for('opentelemetry.js.api.1')] as { trace?: unknown } | undefined;
  return registry !== undefined && registry.trace !== undefined;
}

/**
 * The span ids to record on an entry of the current unit of work: the active OpenTelemetry span
 * when one is active, else telescope's scope. `null` outside both.
 */
export function currentSpanIds(): { spanId: string; parentSpanId: string | null } | null {
  const otel = currentOtelSpan();
  if (otel !== undefined) return { spanId: otel.spanId, parentSpanId: otel.parentSpanId };
  const scope = storage.getStore();
  return scope === undefined ? null : { spanId: scope.spanId, parentSpanId: scope.parentSpanId };
}
