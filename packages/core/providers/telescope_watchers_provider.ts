import type { ApplicationService } from '@adonisjs/core/types';
import {
  getTelescopeExtensionRegistry,
  registerEnabledWatchers,
  setTelescopeQueueManager,
} from '../src/registry.js';
import { CacheWatcher } from '../src/watchers/cache_watcher.js';
import {
  type ResolvedTelescopeWatchersConfig,
  resolveConfig,
  type TelescopeWatchersConfig,
} from '../src/watchers/define_config.js';
import type { EmitterLike, Watcher } from '../src/watchers/emitter.js';
import { EventsWatcher } from '../src/watchers/events_watcher.js';
import { HttpClientWatcher } from '../src/watchers/http_client_watcher.js';
import { type LoggerLike, LogsWatcher } from '../src/watchers/logs_watcher.js';
import { LucidQueryWatcher } from '../src/watchers/lucid_query_watcher.js';
import { MailWatcher } from '../src/watchers/mail_watcher.js';
import { ProfilingWatcher } from '../src/watchers/profiling_watcher.js';
import { type QueueLike, QueueManagerDriver } from '../src/watchers/queue_manager.js';
import { QueueWatcher } from '../src/watchers/queue_watcher.js';
import { RedisWatcher } from '../src/watchers/redis_watcher.js';
import { registerSchedule, ScheduleWatcher } from '../src/watchers/schedule_watcher.js';

/** A watcher with its own (emitter-less) lifecycle — `start()`/`stop()` with no
 *  emitter argument. The http-client watcher publishes an opt-in `instrumentFetch`
 *  default (no global patching); the logs watcher tees the logger instance —
 *  neither taps the event emitter. */
interface LifecycleWatcher {
  readonly type: string;
  stop(): void;
}

/** The structural slice of the core Emitter the events watcher needs: `onAny`. */
interface EmitterWithOnAny {
  onAny(listener: (event: unknown, data: unknown) => unknown): () => void;
}

/**
 * Wires `@adonis-agora/telescope/watchers` into the AdonisJS application.
 *
 * - `boot()` reads `config/telescope_watchers.ts` (falling back to a `watchers`
 *   key on `config/telescope.ts`), resolves the application emitter from the
 *   container, and starts each enabled watcher against it. Each watcher records
 *   through `@adonis-agora/telescope`'s runtime store handle — no DI required.
 * - `shutdown()` stops every started watcher (full unsubscribe).
 *
 * Watchers never throw into the app: a missing config, a missing emitter, or a
 * disabled telescope all degrade to recording nothing.
 */
export default class TelescopeWatchersProvider {
  private readonly started: Array<Watcher | LifecycleWatcher> = [];

  constructor(protected app: ApplicationService) {}

  /** Read the watchers config from its own file or the telescope config block. */
  private resolve(): ResolvedTelescopeWatchersConfig {
    const own = this.app.config.get<TelescopeWatchersConfig | undefined>(
      'telescope_watchers',
      undefined,
    );
    if (own !== undefined) return resolveConfig(own);

    // Fall back to a `watchers` block on the main telescope config, if present.
    const fromTelescope = this.app.config.get<TelescopeWatchersConfig | undefined>(
      'telescope.watchers_config',
      undefined,
    );
    return resolveConfig(fromTelescope);
  }

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;

    let emitter: EmitterLike;
    try {
      emitter = (await this.app.container.make('emitter')) as unknown as EmitterLike;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: could not resolve the emitter: ${message}`);
      return;
    }

    registerEnabledWatchers(config.watchers);

    if (config.watchers.has('query')) {
      await this.warnWhenLucidDebugIsOff();
      this.startWatcher(
        new LucidQueryWatcher({
          slowMs: config.query.slowMs,
          captureBindings: config.query.captureBindings,
          ignoreConnections: config.query.ignoreConnections,
          normalize: config.query.normalize,
        }),
        emitter,
      );
    }
    if (config.watchers.has('mail')) this.startWatcher(new MailWatcher(), emitter);
    if (config.watchers.has('cache')) this.startWatcher(new CacheWatcher(), emitter);
    if (config.watchers.has('http-client')) this.startHttpClientWatcher(config);
    if (config.watchers.has('logs')) await this.startLogsWatcher();
    if (config.watchers.has('queue')) this.startQueueWatcher();
    if (config.watchers.has('events')) this.startEventsWatcher(emitter);
    if (config.watchers.has('redis')) await this.startRedisWatcher(config);
    if (config.watchers.has('profiling')) this.startProfilingWatcher(config);
    if (config.watchers.has('schedule')) this.startScheduleWatcher(config);
    if (config.watchers.has('queue-manager')) await this.startQueueManager(config);
  }

  /** Start the profiling watcher: it publishes a config-backed default for the
   *  opt-in `profile()` / `startProfile()` span helpers (no emitter, no global
   *  patch). While unstarted those helpers are a zero-cost no-op. */
  private startProfilingWatcher(config: ResolvedTelescopeWatchersConfig): void {
    const watcher = new ProfilingWatcher({
      slowMs: config.profiling.slowMs,
      minDurationMs: config.profiling.minDurationMs,
    });
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start profiling watcher: ${message}`);
    }
  }

  /** Start the schedule watcher: it publishes a config-backed default for the
   *  opt-in `scheduleTask()` / `recordScheduledRun()` helpers (AdonisJS ships no
   *  scheduler event to tap, so integration is explicit — no emitter, no global
   *  patch). While unstarted those helpers are a zero-cost no-op. */
  private startScheduleWatcher(config: ResolvedTelescopeWatchersConfig): void {
    const watcher = new ScheduleWatcher({ slowMs: config.schedule.slowMs });
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start schedule watcher: ${message}`);
    }
  }

  /**
   * Publish the Live Queue Manager driver: resolves the OPTIONAL `queue` service from the container
   * (absent when `@adonisjs/queue` isn't installed — the same try/catch-to-null stance the redis
   * watcher uses for `redis`) and constructs a {@link QueueManagerDriver} over it, published on the
   * runtime slot the UI's `/api/queues/live*` routes read. Unlike every other watcher here this
   * publishes to the REGISTRY slot rather than an emitter — it's a live control surface, not an
   * entry recorder — so it has no `stop()`/unsubscribe to track in `this.started`; `shutdown()`
   * clears the slot directly.
   */
  private async startQueueManager(config: ResolvedTelescopeWatchersConfig): Promise<void> {
    let queueService: QueueLike | null = null;
    try {
      queueService = (await this.app.container.make('queue')) as unknown as QueueLike;
    } catch {
      // @adonisjs/queue not installed / not bound — the driver degrades to `configured: false`.
      queueService = null;
    }
    const driver = new QueueManagerDriver(queueService, {
      queues: config.queueManager.queues,
      ...(config.queueManager.adapter !== undefined
        ? { adapter: config.queueManager.adapter }
        : {}),
    });
    setTelescopeQueueManager(driver);
  }

  /** Start the queue watcher: it taps the engine's `node:diagnostics_channel`
   *  trace, so it needs no emitter and no container resolution. A no-op (nothing
   *  publishes) when `@adonisjs/queue` is absent. */
  private startQueueWatcher(): void {
    const watcher = new QueueWatcher();
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start queue watcher: ${message}`);
    }
  }

  /** Start the events watcher: it taps the core Emitter via `onAny`. Degrades to a
   *  no-op when the emitter has no `onAny`. */
  private startEventsWatcher(emitter: EmitterLike): void {
    const watcher = new EventsWatcher();
    try {
      watcher.start(emitter as unknown as EmitterWithOnAny);
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start events watcher: ${message}`);
    }
  }

  /** Start the redis watcher: it instruments the OPTIONAL `@adonisjs/redis`
   *  manager resolved from the container. A missing peer / binding degrades to a
   *  no-op (the watcher itself no-ops on a null manager). */
  private async startRedisWatcher(config: ResolvedTelescopeWatchersConfig): Promise<void> {
    let manager: unknown = null;
    try {
      manager = await this.app.container.make('redis');
    } catch {
      // @adonisjs/redis not installed / not bound — the watcher no-ops on null.
      manager = null;
    }
    const watcher = new RedisWatcher(manager, {
      ignoreCommands: config.redis.ignoreCommands,
      ignoreKeys: config.redis.ignoreKeys,
      ignoreConnections: config.redis.ignoreConnections,
      sampleRate: config.redis.sampleRate,
      floodWarnPerMinute: config.redis.floodWarnPerMinute,
    });
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start redis watcher: ${message}`);
    }
  }

  /** Wire the http-client watcher: it does NOT patch any global (Adonis has no
   *  single built-in HTTP client). Instead it publishes a config-backed default
   *  for the opt-in `instrumentFetch(fetch)` helper users wrap their client with,
   *  so it needs no emitter and no container resolution. */
  private startHttpClientWatcher(config: ResolvedTelescopeWatchersConfig): void {
    const watcher = new HttpClientWatcher({
      slowMs: config.httpClient.slowMs,
      ignoreHosts: config.httpClient.ignoreHosts,
      captureBodies: config.httpClient.captureBodies,
    });
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start http-client watcher: ${message}`);
    }
  }

  /** Start the logs watcher: it taps the application logger resolved from the
   *  container (instance-scoped, reversible method tee — no global patching). */
  private async startLogsWatcher(): Promise<void> {
    let logger: LoggerLike;
    try {
      logger = (await this.app.container.make('logger')) as unknown as LoggerLike;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: could not resolve the logger: ${message}`);
      return;
    }
    const watcher = new LogsWatcher();
    try {
      watcher.start(logger);
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start logs watcher: ${message}`);
    }
  }

  /** Start one watcher, never letting a watcher's `start` break boot. */
  private startWatcher(watcher: Watcher, emitter: EmitterLike): void {
    try {
      watcher.start(emitter);
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `TelescopeWatchersProvider: failed to start ${watcher.type} watcher: ${message}`,
      );
    }
  }

  async shutdown() {
    for (const watcher of this.started) {
      try {
        watcher.stop();
      } catch {
        // never throw out of shutdown
      }
    }
    this.started.length = 0;
    // Clear the queue-manager slot so a re-registering app (tests / HMR) doesn't read a stale driver.
    setTelescopeQueueManager(null);
  }

  /**
   * Pull the schedules the extensions know about into the Live Schedules registry.
   *
   * In `ready()` and not `boot()` because both halves have to already exist: the
   * schedule watcher (started above) and the extension registry (published by the
   * telescope provider). It also means an extension can resolve a live scheduler
   * from the container instead of guessing at boot order.
   *
   * A no-op when the `schedule` watcher is off — `registerSchedule` no-ops then, and
   * the screen says as much.
   */
  async ready(): Promise<void> {
    const registry = getTelescopeExtensionRegistry();
    if (registry === null) return;
    for (const schedule of await registry.collectSchedules()) {
      registerSchedule(schedule);
    }
  }

  /**
   * Warn when the `query` watcher is enabled but Lucid will never emit to it.
   *
   * Lucid only emits `db:query` on a connection whose `debug` flag is on. The common
   * shape is `debug: app.inDev`, so the watcher works perfectly in development and
   * records NOTHING in production — and it fails silently, because a watcher with no
   * events looks exactly like an app with no queries. Someone eventually notices the
   * Queries screen has been empty for weeks.
   *
   * Structural access, in a try/catch: `@adonisjs/lucid` is an optional peer, and a
   * diagnostic warning must never be the thing that breaks boot.
   */
  private async warnWhenLucidDebugIsOff(): Promise<void> {
    try {
      const db = await this.app.container.make('lucid.db' as never);
      const connections = (db as { config?: { connections?: Record<string, { debug?: unknown }> } })
        ?.config?.connections;
      if (connections === undefined) return;

      const names = Object.keys(connections);
      if (names.length === 0) return;
      const withDebug = names.filter((name) => connections[name]?.debug === true);
      if (withDebug.length > 0) return;

      console.warn(
        "Telescope: the 'query' watcher is enabled but no database connection has `debug` on, " +
          'so Lucid never emits `db:query` and NO queries will be recorded. ' +
          `Set \`debug: true\` on the connection(s) you want traced in config/database.ts ` +
          `(checked: ${names.join(', ')}). A common cause is \`debug: app.inDev\`, which is ` +
          'false in production — exactly where the screen is worth having.',
      );
    } catch {
      // Lucid absent or not bound: the watcher no-ops anyway.
    }
  }
}
