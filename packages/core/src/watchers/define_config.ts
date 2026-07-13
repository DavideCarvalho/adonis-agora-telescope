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
 * Tuning for the `http-client` (outbound) watcher. Outbound HTTP is opt-in
 * instrumentation (Adonis has no single built-in client, so nothing is
 * monkey-patched): these values back a bare `instrumentFetch(fetch)` once the
 * provider has wired the watcher.
 */
export interface HttpClientWatcherConfig {
  /** Outbound calls at/above this many ms get a `slow` tag. Default 1000. */
  slowMs?: number;
  /** Hosts (exact, case-insensitive; may include a port) whose calls are not recorded. */
  ignoreHosts?: string[];
  /** Record request/response body SIZES (bytes, never the bytes). Default `false`. */
  captureBodies?: boolean;
}

/** The fully-resolved `http-client` watcher config (no optionals). */
export interface ResolvedHttpClientWatcherConfig {
  slowMs: number;
  ignoreHosts: string[];
  captureBodies: boolean;
}

/** Default outbound slow-call threshold (ms). */
const DEFAULT_HTTP_CLIENT_SLOW_MS = 1000;

/**
 * Tuning for the Lucid `query` watcher — the one enabled by default. It records
 * every SQL query Lucid emits on `db:query`; these knobs govern how much of each
 * query is kept and which are recorded at all.
 */
export interface QueryWatcherConfig {
  /** Queries at/above this many ms get a `slow` tag (feeds the Pulse slow-query
   *  card). Default 500. */
  slowMs?: number;
  /**
   * Record the raw bound parameter VALUES. Bindings routinely carry PII / secrets
   * (emails, tokens, password hashes), so by default they are redacted to
   * `[REDACTED]` placeholders (arity preserved) and only the normalized SQL
   * template is kept. Turn on to capture the real values. Default `false`.
   */
  captureBindings?: boolean;
  /** Connection names (exact, case-insensitive) whose queries are NOT recorded —
   *  e.g. drop the telescope store's own connection from the timeline. */
  ignoreConnections?: string[];
  /**
   * Normalize each SQL string (collapse whitespace, replace literals with `?`)
   * into the `familyHash` grouping key so every execution of the same query
   * template rolls up as one — the N+1 / slow-query grouping. Turn off to hash the
   * raw SQL verbatim (no grouping across differing literals). Default `true`.
   */
  normalize?: boolean;
}

/** The fully-resolved `query` watcher config (no optionals). */
export interface ResolvedQueryWatcherConfig {
  slowMs: number;
  captureBindings: boolean;
  ignoreConnections: string[];
  normalize: boolean;
}

/** Default slow-query threshold (ms). Databases are hotter than outbound HTTP, so
 *  this is lower than the http-client default. */
const DEFAULT_QUERY_SLOW_MS = 500;

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

  /** Tuning for the Lucid `query` watcher (slow threshold, bindings, ignore-connections, normalize). */
  query?: QueryWatcherConfig;

  /** Tuning for the `http-client` watcher (slow threshold, ignore-hosts, body sizes). */
  httpClient?: HttpClientWatcherConfig;
}

/** The fully-resolved watchers config the provider acts on (no optionals). */
export interface ResolvedTelescopeWatchersConfig {
  enabled: boolean;
  watchers: Set<WatcherName>;
  query: ResolvedQueryWatcherConfig;
  httpClient: ResolvedHttpClientWatcherConfig;
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
  const query = config.query ?? {};
  const httpClient = config.httpClient ?? {};
  return {
    enabled: config.enabled ?? true,
    watchers: new Set(config.watchers ?? DEFAULT_WATCHERS),
    query: {
      slowMs: query.slowMs ?? DEFAULT_QUERY_SLOW_MS,
      captureBindings: query.captureBindings ?? false,
      ignoreConnections: query.ignoreConnections ?? [],
      normalize: query.normalize ?? true,
    },
    httpClient: {
      slowMs: httpClient.slowMs ?? DEFAULT_HTTP_CLIENT_SLOW_MS,
      ignoreHosts: httpClient.ignoreHosts ?? [],
      captureBodies: httpClient.captureBodies ?? false,
    },
  };
}
