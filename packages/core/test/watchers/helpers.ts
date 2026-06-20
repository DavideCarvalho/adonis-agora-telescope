import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../../src/registry.js';
import type { TelescopeStore } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import type { EmitterLike } from '../../src/watchers/index.js';

/**
 * A real `@adonisjs/core` Emitter, typed down to our structural {@link EmitterLike}
 * surface. Using the genuine emitter (rather than a hand-rolled double) proves the
 * watchers integrate with the exact `on()` → unsubscribe-function contract Adonis
 * ships.
 */
export function realEmitter(): EmitterLike & { emit(event: string, data: unknown): Promise<void> } {
  const app = new AppFactory().create(new URL('./', import.meta.url));
  const emitter = new EmitterFactory().create(app);
  return emitter as unknown as EmitterLike & {
    emit(event: string, data: unknown): Promise<void>;
  };
}

/** Install a fresh in-memory store on the telescope runtime slot for a test. */
export function installStore(): InMemoryTelescopeStore {
  const store = new InMemoryTelescopeStore({ maxEntries: 1000 });
  setTelescopeRuntime(store, true);
  return store;
}

/** Clear the telescope runtime slot after a test. */
export function clearStore(): void {
  resetTelescopeRuntime();
}

/**
 * Flush the microtask + macrotask queues so a fire-and-forget `void store.record()`
 * inside an emitter subscriber settles before we assert.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A structural emitter double that records subscriptions for unit isolation. */
export function fakeEmitter(): EmitterLike & {
  emit(event: string, data: unknown): void;
  listenerCount(event: string): number;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit(event, data) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

/** A store whose `record` always rejects — to prove watchers never break the emit. */
export function throwingStore(): TelescopeStore {
  return {
    record: () => Promise.reject(new Error('boom')),
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    prune: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
  };
}
