import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks work telescope does on its own behalf — the lucid store's INSERTs, reads and
 * prunes — so the watchers can tell it apart from the app's.
 *
 * The query watcher records every `db:query` Lucid emits, and when the store shares
 * the app's connection its own INSERT is one of them: recorded through the store, it
 * becomes another INSERT, another `db:query`, and the loop never ends. Every
 * ingestion point that goes through `safeRecord` drops entries raised inside this
 * scope.
 *
 * Kept on a `Symbol.for()` global slot like the origin scope, so a store built by
 * one copy of this package and a watcher loaded from another still agree.
 */
const SELF_SCOPE_KEY = Symbol.for('@agora/telescope:self-scope');

const globalSlot = globalThis as Record<symbol, unknown>;

const storage: AsyncLocalStorage<true> =
  (globalSlot[SELF_SCOPE_KEY] as AsyncLocalStorage<true> | undefined) ??
  new AsyncLocalStorage<true>();
globalSlot[SELF_SCOPE_KEY] = storage;

/** Run `fn` as telescope's own work: nothing it causes is recorded. */
export function runAsTelescopeWork<T>(fn: () => T): T {
  return storage.run(true, fn);
}

/** Whether the caller is inside {@link runAsTelescopeWork}. */
export function isTelescopeWork(): boolean {
  return storage.getStore() === true;
}
