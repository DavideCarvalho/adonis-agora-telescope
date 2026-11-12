import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks an operation a telescope watcher records itself (today: a call made through
 * `instrumentFetch`), so `telescopeSpanProcessor()` skips the OpenTelemetry span the same
 * operation produces (the undici span under that `fetch`) — exactly those calls, not every
 * `fetch` in the process.
 *
 * On a `Symbol.for()` global slot so a watcher and a processor loaded from different copies of
 * this package agree.
 */
const COVERED_KEY = Symbol.for('@agora/telescope:covered-scope');

const globalSlot = globalThis as Record<symbol, unknown>;

const storage: AsyncLocalStorage<true> =
  (globalSlot[COVERED_KEY] as AsyncLocalStorage<true> | undefined) ?? new AsyncLocalStorage<true>();
globalSlot[COVERED_KEY] = storage;

/** Run `fn` as an operation a telescope watcher records. */
export function runCoveredByTelescope<T>(fn: () => T): T {
  return storage.run(true, fn);
}

/** Whether the caller is inside {@link runCoveredByTelescope}. */
export function isCoveredByTelescope(): boolean {
  return storage.getStore() === true;
}
