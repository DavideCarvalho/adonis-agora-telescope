/**
 * Structural reader for `@agora/context` — WITHOUT importing it.
 *
 * `@agora/context` publishes a read-only accessor on the cross-copy-stable global
 * slot `Symbol.for('@agora/context:accessor')` at import time. Telescope is a
 * separate repo and cannot depend on `@agora/context`, so it reads that slot
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
 * The narrow read-only view `@agora/context` publishes. Mirrors its
 * `ContextAccessor` structurally — consumers read, they never drive the lifecycle.
 */
export interface ContextAccessor {
  traceId(): string | undefined;
  tenantId(): string | undefined;
  userRef(): UserRef | undefined;
  get(): Record<string, unknown> | undefined;
}

const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/** The accessor `@agora/context` published, or `undefined` when it is not loaded. */
export function getContextAccessor(): ContextAccessor | undefined {
  return (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as ContextAccessor | undefined;
}

/** The active trace id from `@agora/context`, or `null` when unavailable. */
export function currentTraceId(): string | null {
  return getContextAccessor()?.traceId() ?? null;
}
