import { type Entry, EntryType, type RecordInput } from './entry.js';
import { exceptionFamilyHash } from './exception_family_hash.js';
import { getTelescopeRuntime } from './registry.js';
import type { TelescopeStore } from './store.js';

/** The recorded body of an `exception` entry. */
export interface ExceptionEntryContent {
  /** Error class/name (e.g. `TypeError`, `Error`). */
  name: string;
  /** Error message. */
  message: string;
  /** Full stack string, or `null` when none was captured. */
  stack: string | null;
  /** HTTP method, when the exception was recorded inside a request. */
  method: string | null;
  /** Request url (no query string), when recorded inside a request. */
  url: string | null;
  /** The active trace id at record time, or `null`. */
  traceId: string | null;
}

/** Optional request/correlation context for {@link recordException}. */
export interface RecordExceptionContext {
  /** HTTP method (upper-cased by the watcher), when applicable. */
  method?: string;
  /** Request url; the query string is stripped. */
  url?: string;
  /** Override the trace id; defaults to the ambient `@agora/context`. */
  traceId?: string | null;
  /** Override the batch origin; defaults to the store's resolution. */
  origin?: RecordInput['origin'];
}

/** Coerce an unknown thrown value into name/message/stack. */
function normalizeError(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message,
      stack: typeof error.stack === 'string' ? error.stack : null,
    };
  }
  // Non-Error throws (strings, objects) still deserve an entry.
  return { name: 'Error', message: String(error), stack: null };
}

/** Drop a `?query=string` suffix from a url. */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Build the `exception` {@link RecordInput} for `error` + optional context. Pure
 * and side-effect free so it is trivially unit-testable; both the middleware
 * auto-capture and {@link recordException} build through it. The family hash
 * groups same-signature errors (name + message + top stack frame).
 */
export function buildExceptionInput(
  error: unknown,
  context: RecordExceptionContext = {},
): RecordInput<ExceptionEntryContent> {
  const { name, message, stack } = normalizeError(error);
  const method = context.method !== undefined ? context.method.toUpperCase() : null;
  const url = context.url !== undefined ? stripQuery(context.url) : null;
  const familyHash = exceptionFamilyHash({ name, message, stack });

  const tags = [`exception:${name}`, ...(method !== null ? [`method:${method}`] : [])];

  return {
    type: EntryType.Exception,
    content: { name, message, stack, method, url, traceId: context.traceId ?? null },
    familyHash,
    tags,
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    ...(context.origin !== undefined ? { origin: context.origin } : {}),
  };
}

/**
 * Record an `exception` entry into `store` from a thrown value. The pure,
 * framework-agnostic core used by the request middleware. Resolves to the
 * recorded {@link Entry}; backfills the content trace id from whatever the store
 * resolved (the ambient `@agora/context`).
 */
export async function recordExceptionInStore(
  store: TelescopeStore,
  error: unknown,
  context: RecordExceptionContext = {},
): Promise<Entry<ExceptionEntryContent>> {
  const recorded = await store.record(buildExceptionInput(error, context));
  recorded.content.traceId = recorded.traceId;
  return recorded;
}

/**
 * Standalone exception capture for manual / non-HTTP code paths — queue workers,
 * ace commands, and an app's `app/exceptions/handler.ts` `report()`. Reads the
 * active store from the global telescope runtime slot (the same handle the
 * watchers record through) so callers need no DI wiring, and is a no-op when
 * telescope is disabled / not booted.
 *
 * Fire-and-forget-safe: never throws. A missing store or a failing store is
 * swallowed (warn-logged) so capturing an exception can never mask or replace the
 * original error in the caller's failure path.
 *
 * ```ts
 * // app/exceptions/handler.ts
 * import { recordException } from '@agora/telescope'
 * async report(error: unknown, ctx: HttpContext) {
 *   recordException(error, { method: ctx.request.method(), url: ctx.request.url() })
 *   return super.report(error, ctx)
 * }
 * ```
 *
 * Resolves to the recorded {@link Entry}, or `null` when nothing was recorded.
 */
export async function recordException(
  error: unknown,
  context: RecordExceptionContext = {},
): Promise<Entry<ExceptionEntryContent> | null> {
  let store: TelescopeStore | null;
  try {
    store = getTelescopeRuntime().store;
  } catch {
    return null;
  }
  if (store === null) return null;

  try {
    return await recordExceptionInStore(store, error, context);
  } catch (recordError: unknown) {
    // Observability must never break the path it observes.
    console.warn(
      `Telescope: failed to record exception: ${
        recordError instanceof Error ? recordError.message : String(recordError)
      }`,
    );
    return null;
  }
}
