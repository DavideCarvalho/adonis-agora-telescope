import type { ApplicationService } from '@adonisjs/core/types';
import {
  type ClientErrorHttpContext,
  ClientErrorIngestor,
  storeRecorder,
} from '../src/client_errors/index.js';
import {
  type ResolvedTelescopeConfig,
  resolveConfig,
  type TelescopeConfig,
} from '../src/define_config.js';
import { DiagnosticsWatcher } from '../src/diagnostics_watcher.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import type { ExtensionContext } from '../src/extension/types.js';
import { OverloadGuard, type PauseController } from '../src/overload_guard.js';
import { TelescopePruner } from '../src/pruner.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopeEntryEvents,
  setTelescopeExtensionRegistry,
  setTelescopePaused,
  setTelescopeRuntime,
} from '../src/registry.js';
import { SamplingTelescopeStore } from '../src/sampling/sampling_store.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { EntryEvents } from '../src/stream/entry_events.js';
import { StreamingTelescopeStore } from '../src/stream/streaming_store.js';
import { type LoggerLike, LogsWatcher } from '../src/watchers/logs_watcher.js';

/**
 * Wires `@adonis-agora/telescope` into the AdonisJS application.
 *
 * - `register()` binds {@link TelescopeService} into the container, resolving against
 *   whichever store the provider builds at boot, so controllers can `inject()` it.
 * - `boot()` reads `config/telescope.ts`, builds the configured store (a key of
 *   `config.stores`, the `'memory'` shorthand, or a supplied instance), publishes it on
 *   the global runtime slot (so the request middleware can reach it without DI), and
 *   starts the {@link DiagnosticsWatcher} when the `diagnostics` watcher is enabled.
 *   Building the store is async because a driver lazily imports its peer dependency
 *   (`@adonisjs/lucid` for `lucid`) only when it is the selected one.
 * - `shutdown()` stops the watcher and clears the runtime slot.
 *
 * The request watcher itself runs as `server` middleware, which
 * `node ace configure @adonis-agora/telescope` registers on the `server` stack.
 */
export default class TelescopeProvider {
  private store: TelescopeStore | null = null;
  private diagnosticsWatcher: DiagnosticsWatcher | null = null;
  private logsWatcher: LogsWatcher | null = null;
  private entryEvents: EntryEvents | null = null;
  private pruner: TelescopePruner | null = null;
  private overloadGuard: OverloadGuard | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    // The store is built asynchronously at boot (a driver may lazily import its peer
    // dep). Bind the service to resolve against the active store; `boot()` runs before
    // any request, so the store is always set by the time a controller resolves it.
    this.app.container.singleton(TelescopeService, () => {
      const store = this.store ?? new InMemoryTelescopeStore();
      return new TelescopeService(store);
    });
  }

  async boot() {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const store = this.applyStreaming(
      this.applySampling(this.applyRedaction(await this.buildStore(config), config), config),
      config,
    );
    this.store = store;

    if (!config.enabled) {
      resetTelescopeRuntime();
      return;
    }

    setTelescopeRuntime(store, config.watchers.has('request'), config.requestCapture);
    setTelescopeEntryEvents(this.entryEvents);

    if (config.watchers.has('diagnostics')) {
      const watcher = new DiagnosticsWatcher(store, {
        exclude: config.diagnostics.exclude,
        recordClaimed: config.diagnostics.recordClaimed,
      });
      watcher.start();
      this.diagnosticsWatcher = watcher;
    }

    // Tee the app logger into telescope. `LoggerLike` is a structural slice of the
    // AdonisJS logger (level methods), so the container's logger fits without a
    // hard import — keeps this provider decoupled from a specific logger version.
    if (config.watchers.has('logs')) {
      const logger = this.app.container.make('logger') as LoggerLike;
      const watcher = new LogsWatcher({
        minLevel: config.logs.minLevel,
        tags: config.logs.tags,
      });
      watcher.start(logger);
      this.logsWatcher = watcher;
    }

    // Build the extension registry from `config.extensions` and publish it so the UI can serve each
    // extension's dashboards + data providers. A collision (duplicate id/name) throws here, at boot.
    setTelescopeExtensionRegistry(this.buildExtensionRegistry(config, store));

    // Protective infrastructure. The pruner runs only when a `prune` block was
    // supplied; the overload guard is on by default (unref'd 1s sampler) and pauses
    // ingestion through the runtime `paused` flag the middleware + watchers honour.
    if (config.prune.enabled) {
      this.pruner = new TelescopePruner(store, config.prune);
      this.pruner.start();
    }
    if (config.overload.enabled) {
      this.overloadGuard = new OverloadGuard(config.overload, runtimePauseController);
      this.overloadGuard.start();
    }

    // Public client-error ingestion. Opt-in: the route is registered ONLY when
    // enabled, so a disabled endpoint genuinely does not exist (a probe can't
    // tell it is wired). Records through the same wrapped store as every watcher
    // (redaction/sampling/streaming) and sheds while the overload guard pauses.
    if (config.clientErrors.enabled) {
      await this.registerClientErrors(store, config);
    }
  }

  /**
   * Register the `POST <path>` client-error ingestion route on the AdonisJS
   * router, delegating to a {@link ClientErrorIngestor}. Idiomatic AdonisJS: a
   * provider-registered route + `HttpContext` handler, not a NestJS controller.
   */
  private async registerClientErrors(
    store: TelescopeStore,
    config: ResolvedTelescopeConfig,
  ): Promise<void> {
    const ingestor = new ClientErrorIngestor({
      config: config.clientErrors,
      record: storeRecorder(store),
      isPaused: () => getTelescopeRuntime().paused,
    });
    const router = await this.app.container.make('router');
    router
      .post(config.clientErrors.path, (ctx: ClientErrorHttpContext) => ingestor.handle(ctx))
      .as('telescope.client_errors');
  }

  /**
   * Build the active store from config. A supplied {@link TelescopeStore} instance is used
   * as-is; otherwise `config.store` names a driver in `config.stores`, built via its lazy
   * thunk. The bare `'memory'` shorthand (no matching driver) falls back to the built-in
   * ring buffer so `node ace configure`'s zero-config default just works.
   */
  private async buildStore(config: ResolvedTelescopeConfig): Promise<TelescopeStore> {
    if (typeof config.store !== 'string') return config.store;

    const provider = config.stores[config.store];
    if (provider) return provider({ app: this.app });

    if (config.store === 'memory') {
      return new InMemoryTelescopeStore({ maxEntries: config.maxEntries });
    }

    throw new Error(
      `@adonis-agora/telescope: config.store is "${config.store}", but config.stores.${config.store} is not defined`,
    );
  }

  /**
   * Wrap the built store with the CENTRAL redaction decorator so every entry's
   * content is scrubbed before persistence — the single choke point every watcher
   * records through (see {@link RedactingTelescopeStore}). Skipped only when
   * `config.redact.enabled` is `false`.
   */
  private applyRedaction(store: TelescopeStore, config: ResolvedTelescopeConfig): TelescopeStore {
    if (!config.redact.enabled) return store;
    return new RedactingTelescopeStore(store, {
      keys: config.redact.keys,
      perType: config.redact.perType,
    });
  }

  /**
   * Wrap the store with the tail-sampling decorator so dropped entries are never
   * persisted (and skip redaction work too, since this is the OUTERMOST wrap).
   * Skipped entirely when no `sampling` config was supplied — the empty `{}`
   * config keeps everything, so the decorator is omitted for zero overhead.
   */
  private applySampling(store: TelescopeStore, config: ResolvedTelescopeConfig): TelescopeStore {
    if (Object.keys(config.sampling).length === 0) return store;
    return new SamplingTelescopeStore(store, config.sampling);
  }

  /**
   * Wrap the store with the OUTERMOST streaming decorator so each persisted entry
   * — already redacted (inner) and post-sampling (this sees only entries that were
   * stored) — is published to the SSE bus the UI stream route subscribes to.
   * Skipped when `config.stream.enabled` is `false`. The decorator is a no-op while
   * no client is connected, so it stays zero-overhead by default.
   */
  private applyStreaming(store: TelescopeStore, config: ResolvedTelescopeConfig): TelescopeStore {
    if (!config.stream.enabled) return store;
    this.entryEvents = new EntryEvents();
    return new StreamingTelescopeStore(store, this.entryEvents);
  }

  /** Construct the extension registry, giving each extension a context over the store + container. */
  private buildExtensionRegistry(
    config: ResolvedTelescopeConfig,
    store: TelescopeStore,
  ): ExtensionRegistry | null {
    if (config.extensions.length === 0) return null;
    const ctx: ExtensionContext = {
      store,
      container: { make: (token) => this.app.container.make(token as never) },
      config,
    };
    return new ExtensionRegistry(config.extensions, ctx);
  }

  async shutdown() {
    this.overloadGuard?.stop();
    this.overloadGuard = null;
    this.pruner?.stop();
    this.pruner = null;
    this.diagnosticsWatcher?.stop();
    this.diagnosticsWatcher = null;
    this.logsWatcher?.stop();
    this.logsWatcher = null;
    this.entryEvents?.clear();
    this.entryEvents = null;
    resetTelescopeRuntime();
  }
}

/**
 * The overload guard's pause surface, backed by the global runtime `paused` flag
 * every ingestion entry point (request middleware, watcher `safeRecord`) honours —
 * so pausing sheds recording everywhere at once, with no DI wiring.
 */
const runtimePauseController: PauseController = {
  pause: () => setTelescopePaused(true),
  resume: () => setTelescopePaused(false),
  get isPaused() {
    return getTelescopeRuntime().paused;
  },
};
