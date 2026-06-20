/** The per-technology watchers this package ships. */
export type WatcherName = 'query' | 'mail' | 'cache';

/**
 * The shape of `config/telescope_watchers.ts`. Everything is optional: by default
 * only the Lucid `query` watcher is enabled (it is the one whose events are
 * verified against installed types), with `mail` and `cache` opt-in.
 */
export interface TelescopeWatchersConfig {
  /**
   * Master switch. When `false`, no per-technology watcher is started. Default
   * `true`.
   */
  enabled?: boolean;

  /**
   * Which watchers are active. Omit a name to disable it. Default `['query']`.
   *  - `'query'` — records every Lucid SQL query (`db:query`).
   *  - `'mail'`  — records every email sent (`mail:sent`).
   *  - `'cache'` — records `@adonisjs/cache` hit/miss/write/delete events.
   */
  watchers?: WatcherName[];
}

/** The fully-resolved watchers config the provider acts on (no optionals). */
export interface ResolvedTelescopeWatchersConfig {
  enabled: boolean;
  watchers: Set<WatcherName>;
}

/** The default set of enabled watchers — the verified Lucid query watcher only. */
export const DEFAULT_WATCHERS: WatcherName[] = ['query'];

/**
 * Identity helper giving `config/telescope_watchers.ts` full type-checking,
 * mirroring the AdonisJS `defineConfig` convention.
 */
export function defineConfig(config: TelescopeWatchersConfig): TelescopeWatchersConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(
  config: TelescopeWatchersConfig = {},
): ResolvedTelescopeWatchersConfig {
  return {
    enabled: config.enabled ?? true,
    watchers: new Set(config.watchers ?? DEFAULT_WATCHERS),
  };
}
