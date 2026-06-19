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
   * Which store backs telescope. `'memory'` is the only built-in (a bounded ring
   * buffer). A persistent store (`@agora/telescope-lucid`, SQLite) is deferred —
   * see DESIGN.md. Default `'memory'`.
   */
  store?: 'memory';

  /**
   * Hard cap on retained entries for the in-memory store. Oldest entries are
   * evicted past this. Default 1000.
   */
  maxEntries?: number;

  /**
   * Which watchers are active. Omit a name to disable it. Defaults to both
   * (`request` + `diagnostics`).
   */
  watchers?: WatcherName[];
}

/** The fully-resolved config the provider acts on (no optionals). */
export interface ResolvedTelescopeConfig {
  enabled: boolean;
  store: 'memory';
  maxEntries: number;
  watchers: Set<WatcherName>;
}

/**
 * Identity helper giving `config/telescope.ts` full type-checking. Mirrors the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig } from '@agora/telescope'
 * export default defineConfig({ maxEntries: 5000 })
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
    maxEntries: config.maxEntries ?? 1000,
    watchers: new Set(watchers),
  };
}
