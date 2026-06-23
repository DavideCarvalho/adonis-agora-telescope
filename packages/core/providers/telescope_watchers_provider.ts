import type { ApplicationService } from '@adonisjs/core/types';
import { CacheWatcher } from '../src/watchers/cache_watcher.js';
import {
  type ResolvedTelescopeWatchersConfig,
  type TelescopeWatchersConfig,
  resolveConfig,
} from '../src/watchers/define_config.js';
import type { EmitterLike, Watcher } from '../src/watchers/emitter.js';
import { EventsWatcher } from '../src/watchers/events_watcher.js';
import { HttpClientWatcher } from '../src/watchers/http_client_watcher.js';
import { type LoggerLike, LogsWatcher } from '../src/watchers/logs_watcher.js';
import { LucidQueryWatcher } from '../src/watchers/lucid_query_watcher.js';
import { MailWatcher } from '../src/watchers/mail_watcher.js';
import { QueueWatcher } from '../src/watchers/queue_watcher.js';
import { RedisWatcher } from '../src/watchers/redis_watcher.js';

/** A watcher with its own (emitter-less) lifecycle — `start()`/`stop()` with no
 *  emitter argument. The http-client and logs watchers tap the global `fetch`
 *  and the logger instance respectively, not the event emitter. */
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

    if (config.watchers.has('query')) this.startWatcher(new LucidQueryWatcher(), emitter);
    if (config.watchers.has('mail')) this.startWatcher(new MailWatcher(), emitter);
    if (config.watchers.has('cache')) this.startWatcher(new CacheWatcher(), emitter);
    if (config.watchers.has('http-client')) this.startHttpClientWatcher();
    if (config.watchers.has('logs')) await this.startLogsWatcher();
    if (config.watchers.has('queue')) this.startQueueWatcher();
    if (config.watchers.has('events')) this.startEventsWatcher(emitter);
    if (config.watchers.has('redis')) await this.startRedisWatcher();
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
  private async startRedisWatcher(): Promise<void> {
    let manager: unknown = null;
    try {
      manager = await this.app.container.make('redis');
    } catch {
      // @adonisjs/redis not installed / not bound — the watcher no-ops on null.
      manager = null;
    }
    const watcher = new RedisWatcher(manager);
    try {
      watcher.start();
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: failed to start redis watcher: ${message}`);
    }
  }

  /** Start the http-client watcher: it patches the global `fetch`, so it needs
   *  no emitter and no container resolution. */
  private startHttpClientWatcher(): void {
    const watcher = new HttpClientWatcher();
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
  }
}
