/**
 * Structural reader for `@adonis-agora/context` — WITHOUT importing it.
 *
 * `@adonis-agora/context` publishes a read-only accessor on the cross-copy-stable global
 * slot `Symbol.for('@agora/context:accessor')` at import time. Telescope is a
 * separate repo and cannot depend on `@adonis-agora/context`, so it reads that slot
 * structurally and degrades to `undefined` when the package is absent. This keeps
 * request correlation (the active trace id) working when both packages are
 * installed, with zero coupling when only one is.
 */

/** A user reference carried in the context (shape mirrored, not imported). */
export interface UserRef {
  id: string | number;
  [key: string]: unknown;
}

/**
 * The narrow read-only view `@adonis-agora/context` publishes. Mirrors its
 * `ContextAccessor` structurally — consumers read, they never drive the lifecycle.
 */
export interface ContextAccessor {
  traceId(): string | undefined;
  tenantId(): string | undefined;
  userRef(): UserRef | undefined;
  get(): Record<string, unknown> | undefined;
}

const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/** The accessor `@adonis-agora/context` published, or `undefined` when it is not loaded. */
export function getContextAccessor(): ContextAccessor | undefined {
  return (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as ContextAccessor | undefined;
}

const OTEL_TRACE_READER = Symbol.for('@agora/telescope:otel-trace-reader');

/** Reads the trace id of the active OpenTelemetry span, or `undefined` outside one. */
export type OtelTraceIdReader = () => string | undefined;

/**
 * Install (or clear, with `null`) the reader for the active OpenTelemetry trace id. The
 * provider installs one when the app runs `@adonisjs/otel`, so every entry carries the
 * same trace id as the app's spans.
 */
export function setOtelTraceIdReader(reader: OtelTraceIdReader | null): void {
  (globalThis as Record<symbol, unknown>)[OTEL_TRACE_READER] = reader ?? undefined;
}

/** The active OpenTelemetry trace id, or `undefined` when OTel is off or no span is active. */
export function currentOtelTraceId(): string | undefined {
  const reader = (globalThis as Record<symbol, unknown>)[OTEL_TRACE_READER] as
    | OtelTraceIdReader
    | undefined;
  if (reader === undefined) return undefined;
  try {
    return reader();
  } catch {
    return undefined;
  }
}

/**
 * The active trace id: the OpenTelemetry one when a span is active (the app runs
 * `@adonisjs/otel`), else the `@adonis-agora/context` one, else `null`.
 */
export function currentTraceId(): string | null {
  return currentOtelTraceId() ?? getContextAccessor()?.traceId() ?? null;
}

/**
 * Map a trace id a producer resolved from `@adonis-agora/context` to the one telescope
 * records. When `id` is the CURRENT context's trace id (the producer ran in this very
 * async context) and an OpenTelemetry span is active, the OTel trace id wins, so the
 * entry lands in the same trace as the app's spans. Any other id (a message delivered
 * from another process, say) is kept as is.
 */
export function resolveProducerTraceId(id: string | null): string | null {
  if (id === null) return null;
  const otel = currentOtelTraceId();
  if (otel === undefined) return id;
  try {
    return getContextAccessor()?.traceId() === id ? otel : id;
  } catch {
    return id;
  }
}

/**
 * The active user reference from `@adonis-agora/context`, or `undefined`.
 *
 * This is the attribution path for hosts whose auth guard is ASYNCHRONOUS. The
 * `@adonisjs/auth` convention gives watchers a synchronous `ctx.auth.user`, but a
 * guard that only resolves via `await getUser()` has nothing to read at record
 * time — so those hosts publish the resolved reference into the request context
 * instead, and this is where watchers pick it up.
 *
 * Defensive: a throwing accessor yields `undefined`, never an exception into the
 * recording path.
 */
export function currentUserRef(): UserRef | undefined {
  try {
    return getContextAccessor()?.userRef();
  } catch {
    return undefined;
  }
}
