/**
 * NOTE — no `'schedule'` watcher is shipped, intentionally. The NestJS original
 * (`@dudousxd/nestjs-telescope`'s schedule package) wraps `@nestjs/schedule`'s
 * `@Cron`/`@Interval`/`@Timeout` decorators via its `SchedulerRegistry`. AdonisJS
 * has NO first-party scheduler, and the popular community schedulers
 * (`adonisjs-scheduler` et al.) emit nothing on the app emitter and expose no
 * lifecycle hooks — so a generic schedule watcher could only be built by inventing
 * /wrapping a private API. It is therefore deliberately omitted. In the Agora
 * ecosystem, `@adonis-agora/durable` already bridges its scheduled/cron + workflow
 * run events onto the diagnostics bus, which the generic {@link DiagnosticsWatcher}
 * records — so scheduled-run observability is covered there, not by a bespoke
 * schedule watcher.
 */

/** The per-technology watchers this package ships. */
export type WatcherName =
  | 'query'
  | 'mail'
  | 'cache'
  | 'http-client'
  | 'logs'
  | 'queue'
  | 'events'
  | 'redis';

/**
 * The shape of `config/telescope_watchers.ts`. Everything is optional: by default
 * only the Lucid `query` watcher is enabled (it is the one whose events are
 * verified against installed types), with the rest opt-in.
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
   *  - `'http-client'` — records every outbound `fetch` call.
   *  - `'logs'`  — records AdonisJS logger output as `log` entries.
   *  - `'queue'` — records `@adonisjs/queue` job executions (optional peer).
   *  - `'events'` — records every event emitted through the core Emitter.
   *  - `'redis'` — records `@adonisjs/redis` commands (optional peer).
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
