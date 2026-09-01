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

/** The active trace id from `@adonis-agora/context`, or `null` when unavailable. */
export function currentTraceId(): string | null {
  return getContextAccessor()?.traceId() ?? null;
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
