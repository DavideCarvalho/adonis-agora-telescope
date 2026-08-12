/**
 * NOTE — the `'schedule'` watcher is EXPLICIT-integration, by design. The NestJS
 * original (`@dudousxd/nestjs-telescope`'s schedule package) wraps
 * `@nestjs/schedule`'s `@Cron`/`@Interval`/`@Timeout` decorators via its
 * `SchedulerRegistry`. AdonisJS has NO first-party scheduler, and the community
 * schedulers (`adonisjs-scheduler` et al.) emit nothing on the app emitter and
 * expose no lifecycle hook — so there is no stable event to tap. Rather than
 * fabricate one, the schedule watcher's integration point is an explicit wrapper:
 * `scheduleTask(name, fn)` (times a scheduled closure) / `recordScheduledRun(...)`
 * (record an outcome you already have) — see `schedule_watcher.ts`. Enabling it
 * publishes the config-backed default those helpers inherit. (In the Agora
 * ecosystem, `@adonis-agora/durable` also bridges its scheduled/cron runs onto the
 * diagnostics bus, which the {@link DiagnosticsWatcher} records.)
 *
 * The `'profiling'` watcher is likewise user-driven — there is no event to tap.
 * Enabling it publishes the default backing the `profile(label, fn)` /
 * `startProfile(label)` helpers (see `profiling_watcher.ts`); while disabled those
 * helpers are a zero-cost no-op.
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
  | 'redis'
  | 'profiling'
  | 'schedule'
  | 'queue-manager';

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
 * Tuning for the `profiling` watcher — user-instrumented timing spans recorded via
 * the opt-in `profile()` / `startProfile()` helpers. Nothing is captured until the
 * watcher is enabled and those helpers are called around a code section.
 */
export interface ProfilingWatcherConfig {
  /** Spans at/above this many ms get a `slow` tag. Default 100. */
  slowMs?: number;
  /** Spans below this many ms are discarded (too short to be worth an entry). Default 0. */
  minDurationMs?: number;
}

/** The fully-resolved `profiling` watcher config (no optionals). */
export interface ResolvedProfilingWatcherConfig {
  slowMs: number;
  minDurationMs: number;
}

/** Default slow-span threshold (ms) for profiling. */
const DEFAULT_PROFILING_SLOW_MS = 100;

/**
 * Tuning for the `schedule` watcher — scheduled-task runs recorded via the opt-in
 * `scheduleTask()` / `recordScheduledRun()` helpers (AdonisJS ships no scheduler
 * event to tap, so integration is explicit — see `schedule_watcher.ts`).
 */
export interface ScheduleWatcherConfig {
  /** Runs at/above this many ms get a `slow` tag. Default 1000. */
  slowMs?: number;
}

/** The fully-resolved `schedule` watcher config (no optionals). */
export interface ResolvedScheduleWatcherConfig {
  slowMs: number;
}

/** Default slow-run threshold (ms) for scheduled tasks. */
const DEFAULT_SCHEDULE_SLOW_MS = 1000;

/**
 * Config for the `'queue-manager'` capability — the Live Queue Manager driver
 * (`src/watchers/queue_manager.ts`) over the OPTIONAL `@adonisjs/queue` peer. Distinct from the
 * `'queue'` watcher (which records past job EXECUTIONS as `job` entries): this is a live
 * list/inspect/retry/enqueue control surface, not an entry watcher — see `queue_manager.ts`'s module
 * doc for exactly what `@boringnode/queue`'s public API does and doesn't support.
 */
export interface QueueManagerWatcherConfig {
  /**
   * Explicit queue names to surface. REQUIRED to get anything: `@boringnode/queue` has no
   * queue-enumeration API (queue names only exist as strings at dispatch time), so there is nothing
   * to auto-discover. Default `[]` (the driver constructs but reports `configured: false`).
   */
  queues?: string[];
  /** Which configured `@boringnode/queue` adapter to resolve via `queue.use(name)`. Omit to use the
   *  manager's own default adapter. */
  adapter?: string;
}

/** The fully-resolved `queue-manager` config (no optionals). */
export interface ResolvedQueueManagerWatcherConfig {
  queues: string[];
  adapter: string | undefined;
}

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
   *  - `'profiling'` — publishes the `profile()`/`startProfile()` span helpers.
   *  - `'schedule'` — publishes the `scheduleTask()`/`recordScheduledRun()` helpers.
   *  - `'queue-manager'` — publishes the Live Queue Manager driver (list/inspect/retry/enqueue).
   */
  watchers?: WatcherName[];

  /** Tuning for the Lucid `query` watcher (slow threshold, bindings, ignore-connections, normalize). */
  query?: QueryWatcherConfig;

  /** Tuning for the `http-client` watcher (slow threshold, ignore-hosts, body sizes). */
  httpClient?: HttpClientWatcherConfig;

  /** Tuning for the `profiling` watcher (slow-span threshold, min duration floor). */
  profiling?: ProfilingWatcherConfig;

  /** Tuning for the `schedule` watcher (slow-run threshold). */
  schedule?: ScheduleWatcherConfig;

  /** Config for the `queue-manager` capability (explicit queue names, adapter selection). */
  queueManager?: QueueManagerWatcherConfig;
}

/** The fully-resolved watchers config the provider acts on (no optionals). */
export interface ResolvedTelescopeWatchersConfig {
  enabled: boolean;
  watchers: Set<WatcherName>;
  query: ResolvedQueryWatcherConfig;
  httpClient: ResolvedHttpClientWatcherConfig;
  profiling: ResolvedProfilingWatcherConfig;
  schedule: ResolvedScheduleWatcherConfig;
  queueManager: ResolvedQueueManagerWatcherConfig;
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
  const profiling = config.profiling ?? {};
  const schedule = config.schedule ?? {};
  const queueManager = config.queueManager ?? {};
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
    profiling: {
      slowMs: profiling.slowMs ?? DEFAULT_PROFILING_SLOW_MS,
      minDurationMs: Math.max(0, profiling.minDurationMs ?? 0),
    },
    schedule: {
      slowMs: schedule.slowMs ?? DEFAULT_SCHEDULE_SLOW_MS,
    },
    queueManager: {
      queues: queueManager.queues ?? [],
      adapter: queueManager.adapter,
    },
  };
}
