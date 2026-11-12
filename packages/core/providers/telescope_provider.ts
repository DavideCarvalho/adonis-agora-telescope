import type { ApplicationService } from '@adonisjs/core/types';
import { AgentMetricsRegistry } from '../src/ai_metrics/agent_metrics.js';
import type { OtelMetricsExporter } from '../src/ai_metrics/otel_metrics_exporter.js';
import { subscribeAgentObservations } from '../src/ai_metrics/subscribe.js';
import {
  type ClientErrorHttpContext,
  ClientErrorIngestor,
  storeRecorder,
} from '../src/client_errors/index.js';
import { setOtelTraceIdReader } from '../src/context_accessor.js';
import {
  type ResolvedTelescopeConfig,
  resolveConfig,
  type TelescopeConfig,
} from '../src/define_config.js';
import { DiagnosticsWatcher } from '../src/diagnostics_watcher.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import {
  dbSchemaDoctorCheck,
  type SchemaInspectable,
  telescopeDoctorChecks,
} from '../src/doctor/checks.js';
import {
  ensureTelescopeExtensionsBinding,
  mergeExtensions,
  readBoundExtensions,
} from '../src/extension/binding.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import type { ExtensionContext } from '../src/extension/types.js';
import { isGlobalOtelRegistered } from '../src/otel/detect.js';
import { OverloadGuard, type PauseController } from '../src/overload_guard.js';
import { TelescopePruner } from '../src/pruner.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import {
  getTelescopeRuntime,
  registerEnabledWatchers,
  resetTelescopeRuntime,
  setTelescopeAiMetrics,
  setTelescopeEntryEvents,
  setTelescopeExtensionRegistry,
  setTelescopePaused,
  setTelescopeRecordHeartbeat,
  setTelescopeRuntime,
} from '../src/registry.js';
import { SamplingTelescopeStore } from '../src/sampling/sampling_store.js';
import { setTelescopeWorkWrapper } from '../src/self_scope.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { EntryEvents } from '../src/stream/entry_events.js';
import { StreamingTelescopeStore } from '../src/stream/streaming_store.js';
import { tenancySlot } from '../src/tenancy.js';
import { TenantTaggingStore } from '../src/tenancy_store.js';
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
  private otelReaderInstalled = false;
  private otelMetricsExporter: OtelMetricsExporter | null = null;
  private unsubscribePrometheus: (() => void) | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    // Libraries push their telescope extension into `'agora.telescope.extensions'` from their own
    // `register()`; whoever runs first creates it. It is read once, at boot.
    ensureTelescopeExtensionsBinding(this.app.container);

    // The store is built asynchronously at boot (a driver may lazily import its peer
    // dep). Bind the service to resolve against the active store; `boot()` runs before
    // any request, so the store is always set by the time a controller resolves it.
    this.app.container.singleton(TelescopeService, () => {
      const store = this.store ?? new InMemoryTelescopeStore();
      return new TelescopeService(store);
    });
  }

  async boot() {
    // `node ace agora:doctor` reads these after boot. Registered here rather than in `register()`,
    // which AdonisJS does not await; before the `enabled` check so a disabled telescope is checked too.
    await registerDoctorChecks(this.app.container, telescopeDoctorChecks).catch(() => {});
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const built = await this.buildStore(config);
    await this.registerSchemaCheck(built);
    const sampled = this.applySampling(this.applyRedaction(built, config), config);
    // Outermost: the tenant tags are on the entry before redaction, sampling, OTel and the stream
    // see it. Only when @adonis-agora/context publishes tenancy and telescope did not opt out.
    const wrapped = this.applyStreaming(await this.applyOtel(sampled, config), config);
    const store =
      config.tenancy.enabled !== false && tenancySlot() !== undefined
        ? new TenantTaggingStore(wrapped, config.tenancy)
        : wrapped;
    this.store = store;

    if (!config.enabled) {
      resetTelescopeRuntime();
      return;
    }

    setTelescopeRuntime(
      store,
      config.watchers.has('request'),
      config.requestCapture,
      config.requestEnrichment,
    );
    setTelescopeEntryEvents(this.entryEvents);
    setTelescopeRecordHeartbeat(config.recordHeartbeat);

    await this.startAiMetrics(config);

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
    registerEnabledWatchers(config.watchers);

    if (config.watchers.has('logs')) {
      // AWAITED. `container.make()` returns a Promise, and the cast below used to hide
      // that: the watcher received a Promise, found no level methods on it, teed
      // nothing and returned — silently, because "nothing to tee" was not an error.
      // The `logs` watcher recorded zero entries in production for weeks.
      const logger = (await this.app.container.make('logger')) as unknown as LoggerLike;
      const watcher = new LogsWatcher({
        minLevel: config.logs.minLevel,
        tags: config.logs.tags,
      });
      watcher.start(logger);
      this.logsWatcher = watcher;
    }

    // Build the extension registry from `config.extensions` and publish it so the UI can serve each
    // extension's dashboards + data providers. A collision (duplicate id/name) throws here, at boot.
    setTelescopeExtensionRegistry(await this.buildExtensionRegistry(config, store));

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
   * With a SQL store (alone or as a tiered store's hot tier) that has a `schema`, add the
   * deep `telescope.db-schema` doctor check for it. Without a schema nothing is added.
   */
  private async registerSchemaCheck(store: TelescopeStore): Promise<void> {
    const hot = (store as { hot?: unknown }).hot;
    const candidate = (hot ?? store) as Partial<SchemaInspectable> & { schema?: unknown };
    if (typeof candidate.inspectSchema !== 'function' || typeof candidate.schema !== 'string') {
      return;
    }
    await registerDoctorChecks(this.app.container, [
      dbSchemaDoctorCheck(candidate as SchemaInspectable),
    ]).catch(() => {});
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

  /**
   * Route telescope into the app's OpenTelemetry pipeline when one is running (the app loads
   * `@adonisjs/otel` in `otel.ts`, which registers the global providers before the app boots):
   *
   * - every entry takes the trace id of the active OTel span, so telescope entries and the
   *   app's spans share one trace;
   * - telescope's own storage work runs with tracing suppressed, so its INSERTs and reads are
   *   not exported as app spans;
   * - unless `otel: false`, the store is wrapped with the emitting decorator, AFTER redaction
   *   and sampling (like streaming), so only what the local store kept is emitted.
   *
   * Without an SDK nothing changes and `@opentelemetry/api` is never loaded.
   */
  private async applyOtel(
    store: TelescopeStore,
    config: ResolvedTelescopeConfig,
  ): Promise<TelescopeStore> {
    if (!config.enabled || !isGlobalOtelRegistered()) return store;
    try {
      const otel = await import('../src/otel/global_emitter.js');
      setOtelTraceIdReader(otel.readActiveOtelTraceId);
      setTelescopeWorkWrapper(otel.withoutTracing);
      this.otelReaderInstalled = true;
      if (!config.otel.enabled) return store;
      const { OtelEmittingTelescopeStore } = await import('../src/otel/otel_emitting_store.js');
      return new OtelEmittingTelescopeStore(
        store,
        otel.createGlobalOtelEmitter(),
        config.otel.entryTypes,
      );
    } catch (err) {
      console.error(
        '@adonis-agora/telescope: an OpenTelemetry SDK is running, but @opentelemetry/api ' +
          'could not be loaded. Entries are recorded but not sent to OpenTelemetry:',
        err,
      );
      return store;
    }
  }

  /**
   * Start the AI-usage / agent-run metrics: the in-process registry behind the Prometheus scrape
   * (`prometheus.enabled`) and the instruments on the app's OpenTelemetry meter (when an SDK is
   * running, unless `otel: false` or `otel.metrics: false`). Both subscribe to the
   * `agora:agent:*` channels directly, independent of the `diagnostics` watcher and of sampling,
   * so every event is counted exactly once.
   */
  private async startAiMetrics(config: ResolvedTelescopeConfig): Promise<void> {
    if (config.prometheus.enabled) {
      const registry = new AgentMetricsRegistry({
        maxSeriesPerMetric: config.prometheus.maxSeriesPerMetric,
      });
      this.unsubscribePrometheus = subscribeAgentObservations((o) => registry.observe(o));
      setTelescopeAiMetrics(registry);
    }
    if (!config.otel.metrics || !isGlobalOtelRegistered()) return;
    try {
      const [{ createOtelMetricsExporter }, { globalTelescopeMeter }] = await Promise.all([
        import('../src/ai_metrics/otel_metrics_exporter.js'),
        import('../src/otel/global_emitter.js'),
      ]);
      this.otelMetricsExporter = createOtelMetricsExporter(globalTelescopeMeter());
    } catch (err) {
      console.error(
        '@adonis-agora/telescope: an OpenTelemetry SDK is running, but @opentelemetry/api ' +
          'could not be loaded. AI-usage metrics are not sent to OpenTelemetry:',
        err,
      );
    }
  }

  /**
   * Construct the extension registry, giving each extension a context over the store + container.
   * Extensions come from `config.extensions` plus whatever libraries pushed into the
   * `'agora.telescope.extensions'` binding; a configured extension wins over a bound one with the
   * same `name`.
   */
  private async buildExtensionRegistry(
    config: ResolvedTelescopeConfig,
    store: TelescopeStore,
  ): Promise<ExtensionRegistry | null> {
    const bound = await readBoundExtensions(this.app.container);
    const extensions = mergeExtensions(config.extensions, bound, (name) => {
      void this.debug(
        `[@adonis-agora/telescope] extension "${name}" is listed in config/telescope.ts and also registered by its library; using the configured one.`,
      );
    });
    if (extensions.length === 0) return null;
    const ctx: ExtensionContext = {
      store,
      container: { make: (token) => this.app.container.make(token as never) },
      config,
    };
    return new ExtensionRegistry(extensions, ctx);
  }

  /** Log at debug through the app logger when one is bound. Never throws. */
  private async debug(message: string): Promise<void> {
    try {
      const logger = (await this.app.container.make('logger')) as { debug(msg: string): void };
      logger.debug(message);
    } catch {
      // No logger: nothing to say.
    }
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
    if (this.otelReaderInstalled) {
      setOtelTraceIdReader(null);
      setTelescopeWorkWrapper(null);
    }
    this.otelReaderInstalled = false;
    this.unsubscribePrometheus?.();
    this.unsubscribePrometheus = null;
    this.otelMetricsExporter?.shutdown();
    this.otelMetricsExporter = null;
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
