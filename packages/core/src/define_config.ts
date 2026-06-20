import type { TelescopeExtension } from './extension/types.js';
import type { TelescopeStore } from './store.js';
import { type StoreProvider, storage } from './stores/factory.js';

/** The set of watchers this headless slice ships. */
export type WatcherName = 'request' | 'diagnostics';

/**
 * The shape of `config/telescope.ts`. Everything is optional with sane defaults:
 * the in-memory store, both shipped watchers enabled, a 1000-entry cap.
 */
export interface TelescopeConfig {
  /**
   * Master switch. When `false`, the provider records nothing and both watchers
   * stay dormant (zero overhead). Default `true`.
   */
  enabled?: boolean;

  /**
   * Which store backs telescope. Three forms are accepted:
   *
   * - a **key of {@link stores}** (the idiomatic form) — e.g. `'memory'` or `'lucid'`,
   *   selecting one of the drivers built with the {@link storage} factory;
   * - the literal `'memory'` — the built-in ring buffer, even with no `stores` map;
   * - a {@link TelescopeStore} instance — for a custom backend wired by hand.
   *
   * Default `'memory'`.
   */
  store?: string | TelescopeStore;

  /**
   * Named store drivers, built with the {@link storage} factory. The active one is
   * selected by {@link store}. Each factory returns a lazy thunk; its peer dependency
   * (`@adonisjs/lucid` for `lucid`) is only imported when that driver is the active one.
   */
  stores?: Record<string, StoreProvider>;

  /**
   * Hard cap on retained entries for the in-memory store when selected by the bare
   * `store: 'memory'` shorthand (no `stores` map). Oldest entries are evicted past
   * this. Default 1000. Prefer `storage.memory({ limit })` in the `stores` map.
   */
  maxEntries?: number;

  /**
   * Which watchers are active. Omit a name to disable it. Defaults to both
   * (`request` + `diagnostics`).
   */
  watchers?: WatcherName[];

  /**
   * Extensions contributed by sibling libs (e.g. `@agora/durable-telescope`) — each adds navigable
   * entry types, dashboard pages, and the data providers those pages bind to. Default none.
   */
  extensions?: TelescopeExtension[];
}

/** The fully-resolved config the provider acts on (no optionals). */
export interface ResolvedTelescopeConfig {
  enabled: boolean;
  store: string | TelescopeStore;
  stores: Record<string, StoreProvider>;
  maxEntries: number;
  watchers: Set<WatcherName>;
  extensions: TelescopeExtension[];
}

/**
 * Identity helper giving `config/telescope.ts` full type-checking. Mirrors the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig, storage } from '@agora/telescope'
 *
 * export default defineConfig({
 *   store: 'memory',
 *   stores: {
 *     memory: storage.memory({ limit: 1000 }),
 *     lucid: storage.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 */
export function defineConfig(config: TelescopeConfig): TelescopeConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeConfig = {}): ResolvedTelescopeConfig {
  const watchers = config.watchers ?? ['request', 'diagnostics'];
  return {
    enabled: config.enabled ?? true,
    store: config.store ?? 'memory',
    stores: config.stores ?? {},
    maxEntries: config.maxEntries ?? 1000,
    watchers: new Set(watchers),
    extensions: config.extensions ?? [],
  };
}

export { storage };
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
