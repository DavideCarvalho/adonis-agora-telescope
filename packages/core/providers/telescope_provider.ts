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
import { type RunningDiscovery, startDiscovery } from '../src/discovery/index.js';
import { DiscoveryPublisher } from '../src/discovery/server.js';
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
import {
  appUnauthenticatedMessage,
  authkitUsable,
  ConsoleAuthConfigError,
  planAppAuth,
} from '../src/federation/auto_crypto.js';
import {
  appKeyOf as appKeyOfApp,
  type ConsoleCommandKeys,
  consoleCommandKeys,
  consoleKeyId,
  DEFAULT_CONSOLE_PREFIX,
} from '../src/federation/console_commands.js';
import { HealthChecks } from '../src/fleet/checks.js';
import {
  type ReportingCommand,
  reportingRole,
  resolveSelfApp,
  resolveVersion,
} from '../src/fleet/config.js';
import type { InstanceState } from '../src/fleet/heartbeat.js';
import { type ProbeRouter, registerProbeRoutes } from '../src/fleet/probes.js';
import { FleetRegistry, InstanceReporter } from '../src/fleet/registry.js';
import { observeShutdownSignals } from '../src/fleet/signals.js';
import { describeStack, type StackEntry } from '../src/fleet/stack.js';
import { type FleetStore, LucidFleetStore, MemoryFleetStore } from '../src/fleet/store.js';
import { isGlobalOtelRegistered } from '../src/otel/detect.js';
import { OverloadGuard, type PauseController } from '../src/overload_guard.js';
import { TelescopePruner } from '../src/pruner.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import {
  getEnabledWatchers,
  getTelescopeRuntime,
  registerEnabledWatchers,
  resetTelescopeRuntime,
  setTelescopeAiMetrics,
  setTelescopeEntryEvents,
  setTelescopeExtensionRegistry,
  setTelescopeFleet,
  setTelescopeIgnoreRequestPaths,
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
import { fillTenantFromAuthkit, MissingTenantError } from '../src/topology/auto_tenant.js';
import { createIngestHandler } from '../src/topology/ingest.js';
import { activeRemoteStores, RemoteTelescopeStore } from '../src/topology/remote_store.js';
import { type IngestRouter, registerIngestRoutes } from '../src/topology/routes.js';
import type { ControlPlaneChannel, TransportContext } from '../src/topology/transports/types.js';
import { installPropagation } from '../src/tracing/index.js';
import { setOtelSpanReader } from '../src/tracing/scope.js';
import { type LoggerLike, LogsWatcher } from '../src/watchers/logs_watcher.js';

/** The slice of ace's kernel the fleet uses (`@adonisjs/ace`, bound as `ace` by `node ace`). */
interface AceKernelLike {
  executing(callback: (command: unknown, isMain: boolean) => Promise<void> | void): unknown;
}

/** The slice of an ace command class the fleet reads. */
interface AceCommandClassLike {
  commandName?: unknown;
  options?: { staysAlive?: unknown };
}

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
  /** The store as built, before any decorator (the fleet puts its table next to a Lucid one). */
  private localStore: TelescopeStore | null = null;
  private remote: RemoteTelescopeStore | null = null;
  /** A control plane's broker consumer (`transport` other than HTTP). */
  private consumer: ControlPlaneChannel | null = null;
  private diagnosticsWatcher: DiagnosticsWatcher | null = null;
  private logsWatcher: LogsWatcher | null = null;
  private entryEvents: EntryEvents | null = null;
  private pruner: TelescopePruner | null = null;
  private overloadGuard: OverloadGuard | null = null;
  private otelReaderInstalled = false;
  private otelMetricsExporter: OtelMetricsExporter | null = null;
  private unsubscribePrometheus: (() => void) | null = null;
  private fleet: FleetRegistry | null = null;
  /** Stops answering other consoles' commands (`consoleCommands`). */
  private stopConsoleCommands: (() => void) | null = null;
  private reporter: InstanceReporter | null = null;
  private healthChecks: HealthChecks | null = null;
  private stopPropagation: (() => void) | null = null;
  private discovery: RunningDiscovery | null = null;
  private discoveryPublisher: DiscoveryPublisher | null = null;
  private stopDrainOnSignal: (() => void) | null = null;
  /** Telescope is off in this process: a tenant without url/token/partition outside `web`. */
  private off = false;

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
    const raw = this.app.config.get<TelescopeConfig>('telescope', {});
    // `topology: 'tenant'` without url/token/partition: @adonis-agora/authkit-client supplies them.
    await fillTenantFromAuthkit(this.app.container, raw);
    const config = await this.resolveOrSkip(raw);
    if (config === null) return;
    const local = await this.buildStore(config);
    this.localStore = local;
    await this.registerSchemaCheck(local);
    const built = this.applyTopology(local, config);
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
    await this.assertConsoleCommandsAuth(config);

    setTelescopeRuntime(
      store,
      config.watchers.has('request'),
      config.requestCapture,
      config.requestEnrichment,
    );
    setTelescopeEntryEvents(this.entryEvents);
    // Tracing across apps: incoming `traceparent`, outgoing calls to `propagation.targets`, jobs.
    this.stopPropagation = installPropagation(config.propagation, config.propagationConfigured);
    setTelescopeRecordHeartbeat(config.recordHeartbeat);
    setTelescopeIgnoreRequestPaths(config.ignoreRequestPaths);

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

    // Health checks, the fleet and this instance's heartbeat (before the ingest routes, which
    // hand the tenants' heartbeats to the fleet).
    await this.startFleet(config);

    // Central server: a tenant starts sending; a control plane mounts the ingest routes.
    this.remote?.start();
    if (config.topology.topology === 'control-plane') await this.registerIngest(config);

    // Service discovery: `fetch('http://billing/…')` reaches the app named billing.
    this.discovery = await startDiscovery({
      config: config.discovery,
      topology: config.topology,
      onError: (message) => void this.debug(`[@adonis-agora/telescope] discovery: ${message}`),
      // §12: only a process that serves long-polls the central server. An ace command, the REPL or
      // the test runner must exit when done; a worker command (staysAlive) starts it below.
      poll: this.serves(),
    });
    if (this.discovery !== null && this.environment() === 'console') {
      const discovery = this.discovery;
      await this.onAceCommand((command) => {
        if (command.staysAlive) discovery.poll();
      });
    }
  }

  /** The app is serving: this instance is ready. */
  async ready() {
    // Providers that composed onto the global dispatcher during boot (an auth token, an
    // encryption envelope) now sit outside the rewrite: put it back on top, so they see real origins.
    await this.discovery?.ready();
    await this.reporter?.setState('ready');
    await this.startConsoleCommands();
  }

  /**
   * `consoleCommands`: answer the commands another app's console sends (it reads this app's
   * entries federated, from this app's store). Only the web process answers: a replay needs the
   * HTTP server, and an ace command must not claim a command and exit.
   */
  private async startConsoleCommands(): Promise<void> {
    if (this.off) return;
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const commands = config.consoleCommands;
    const store = this.store;
    if (!config.enabled || commands === null || store === null || this.stopConsoleCommands) return;
    if (this.environment() !== 'web') return;
    try {
      const [
        { answerConsoleCommands, appKeyOf, consoleCommandKeys, DEFAULT_CONSOLE_PREFIX },
        { consoleCommandHandler, CONSOLE_COMMAND_VERBS },
        { buildConsoleApis },
        fed,
        siblings,
      ] = await Promise.all([
        import('../src/federation/console_commands.js'),
        import('../src/federation/answer.js'),
        import('../src/ui/console_apis.js'),
        import('../src/federation/federation.js'),
        import('../src/federation/auto_crypto.js'),
      ]);
      const container = this.app.container;
      const client = commands.client ?? (await fed.redisConnection(this.app, commands.connection));
      const actions = commands.actions ?? {};
      const logger = await this.app.container
        .make('logger')
        .then((made) => made as unknown as { info(message: string): void })
        .catch(() => null);
      const prefix = commands.prefix ?? DEFAULT_CONSOLE_PREFIX;
      const partition = this.consolePartition(config);
      const appKey = await appKeyOf(this.app);
      const plan = await this.consoleAuthPlan(config);

      // Automatic crypto: open with this app's own @adonis-agora/crypto, its console key made
      // sure of (created where this app may; otherwise one line says what to run).
      let crypto = commands.crypto === false ? undefined : commands.crypto;
      if (plan.autoCrypto) {
        const runtime = await siblings.cryptoRuntimeOf(container);
        if (runtime !== undefined) {
          const logKey = (note: { level: 'info' | 'warn'; line: string }) =>
            note.level === 'warn' ? void this.warn(note.line) : logger?.info(note.line);
          // A crypto tenant: its key checked once at boot (one actionable line when missing or
          // refused), then each command's own decrypt is the retry, classified the same way.
          const watch =
            runtime.service === undefined
              ? siblings.watchTenantConsoleKey(runtime, logKey)
              : undefined;
          const own = siblings.appConsoleCipher(runtime, watch?.decrypt);
          crypto = { cipher: own.cipher };
          if (runtime.service !== undefined) {
            // Crypto embedded here: create the key now (once; a failure is retried on the first
            // command), so a console can seal before it.
            void own
              .ready()
              .catch((error: unknown) =>
                this.warn(siblings.keyCreateFailedLine(runtime.partition, error)),
              );
          } else {
            void watch?.atBoot();
          }
        }
      }
      // authkit's calls between apps: the console's app-call token, bound to this app.
      const verifyAppCaller = plan.appCall
        ? siblings.appCallerVerifierOf(await siblings.authkitOf(container))
        : undefined;
      const verifyTenant = commands.verifyTenant === false ? undefined : commands.verifyTenant;
      const fallbackVerifyTenant =
        plan.fallbackVerifier && config.topology.topology === 'control-plane'
          ? config.topology.verifyTenant
          : undefined;
      let keys: ConsoleCommandKeys | undefined;
      if (plan.keys && appKey !== undefined) {
        // Only its short id reaches the boot log; `node ace telescope:console:key` prints the key.
        keys = consoleCommandKeys(appKey, prefix);
        // Token mode: publish the public half in authkit's key directory (§2e.B), so consoles find
        // it without copying it. Background and retried by authkit-client; never fails the boot.
        // With crypto active, crypto is enough: nothing is published (a console then picks
        // crypto, §13a) and nothing is said (§13e; the doctor shows it), unless crypto commands
        // must carry a token too (explicit crypto + verifyTenant, migrating).
        const tokenRequired =
          commands.crypto !== undefined &&
          commands.crypto !== false &&
          commands.verifyTenant !== undefined &&
          commands.verifyTenant !== false;
        if (crypto === undefined || tokenRequired) {
          const authkit = await siblings.authkitOf(container);
          if (typeof authkit?.publishAppKey === 'function') {
            void siblings.publishConsoleKey(authkit, keys.publicKey).catch(() => undefined);
          } else if (crypto === undefined && commands.secret === undefined) {
            // Token mode is this app's only way to be reached, and no console can find its key.
            await this.warn(
              "[@adonis-agora/telescope] console commands: token mode is this app's only way to be reached, but authkit-client's `service` is not configured, so its key is not in authkit's key directory: configure it, or give each console apps.federated.<app>.commands.publicKey (`node ace telescope:console:key` prints it)",
            );
          }
        }
      }
      const refusals = new Set<string>();
      this.stopConsoleCommands = await answerConsoleCommands(
        client,
        (command) =>
          consoleCommandHandler({
            // Built per command: the queue manager and health checks are read from the runtime
            // slots other providers fill.
            apis: buildConsoleApis(store, {
              coreConfig: config,
              uiConfig: { replay: { enabled: actions.replay === true } },
              container: { make: (token) => this.app.container.make(token as never) },
              audit: () => {},
            }),
            actions,
            partition,
            log: (line) => logger?.info(line),
          })(command),
        {
          prefix,
          verbs: Object.keys(CONSOLE_COMMAND_VERBS),
          ...(commands.secret !== undefined ? { secret: commands.secret } : {}),
          ...(crypto !== undefined ? { crypto } : {}),
          ...(verifyTenant !== undefined ? { verifyTenant } : {}),
          ...(fallbackVerifyTenant !== undefined ? { fallbackVerifyTenant } : {}),
          ...(verifyAppCaller !== undefined ? { verifyAppCaller } : {}),
          ...(keys !== undefined ? { keys } : {}),
          partition,
          // A refused command is someone on this Redis without the console's credentials, or a
          // console configured for another mode: worth a warning, never silent.
          // Never crashes on a bad message: logged once per reason, then dropped.
          onError: (message) => {
            if (refusals.has(message)) return;
            if (refusals.size < 100) refusals.add(message);
            void this.warn(
              `[@adonis-agora/telescope] console commands: refused a command (${message})`,
            );
          },
        },
      );
      const resolved = planAppAuth(commands, {
        cryptoBound: crypto !== undefined && plan.autoCrypto,
        authkitBound: verifyAppCaller !== undefined,
        appKey: appKey !== undefined,
        appName: partition,
        controlPlaneVerifier: fallbackVerifyTenant !== undefined,
        keyId: keys !== undefined ? consoleKeyId(keys.publicKey) : undefined,
      });
      const actionsOn = actions.replay === true || actions.queues === true;
      logger?.info(
        `[@adonis-agora/telescope] console commands: ${resolved.modes.join(' + ')}; ${
          actionsOn
            ? 'actions on'
            : 'actions off (set consoleCommands.actions.replay or consoleCommands.actions.queues to let the console act)'
        }`,
      );
    } catch (error) {
      await this.warn(
        `[@adonis-agora/telescope] consoleCommands: not answering other consoles' commands: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `resolveConfig`, except that a tenant missing url/token/partition (and no authkit-client to
   * supply them) fails only where entries would be sent: the web process, and an ace command that
   * stays alive (a worker). Other ace commands, the REPL and tests run without telescope and warn.
   */
  private async resolveOrSkip(raw: TelescopeConfig): Promise<ResolvedTelescopeConfig | null> {
    try {
      return resolveConfig(raw);
    } catch (error) {
      if (!(error instanceof MissingTenantError) || this.serves()) throw error;
      this.off = true;
      resetTelescopeRuntime();
      await this.warn(`${error.message} Telescope is off in this process.`);
      try {
        const kernel = (await this.app.container.make('ace' as never)) as AceKernelLike | undefined;
        kernel?.executing?.(async (command, isMain) => {
          if (!isMain) return;
          const ctor = (command as { constructor?: AceCommandClassLike }).constructor;
          const staysAlive =
            (command as { staysAlive?: unknown }).staysAlive ?? ctor?.options?.staysAlive;
          if (staysAlive === true) throw error;
        });
      } catch {
        // No ace kernel: nothing stays alive here.
      }
      return null;
    }
  }

  /** Whether this process serves (web, or a host without environments): only it long-polls. */
  private serves(): boolean {
    const environment = this.environment();
    return environment === undefined || environment === 'web';
  }

  private environment(): string | undefined {
    return (this.app as { getEnvironment?(): string }).getEnvironment?.();
  }

  /**
   * This app's partition, which a classic token's partition must be: `consoleCommands.partition`,
   * else a tenant's partition, else the app's name (`fleet.app`, `APP_NAME`), else the prefix.
   */
  private consolePartition(config: ResolvedTelescopeConfig): string {
    const commands = config.consoleCommands;
    const envName = process.env.APP_NAME?.trim();
    return (
      commands?.partition ??
      (config.topology.topology === 'tenant' ? config.topology.tenant.partition : undefined) ??
      config.fleet.app ??
      (envName ? envName : undefined) ??
      commands?.prefix ??
      'telescope'
    );
  }

  /**
   * Which modes `consoleCommands` resolves, from what is configured and what the siblings actually
   * provide: crypto by its binding, authkit by a usable app-caller verifier (a binding without
   * calls between apps configured provides none).
   */
  private async consoleAuthPlan(config: ResolvedTelescopeConfig) {
    const commands = config.consoleCommands ?? {};
    const container = this.app.container as unknown as { hasBinding?(b: string): boolean };
    const authkit = await authkitUsable(this.app.container);
    const appKeyValue = await appKeyOfApp(this.app);
    return planAppAuth(commands, {
      keyId:
        appKeyValue !== undefined
          ? consoleKeyId(
              consoleCommandKeys(appKeyValue, commands.prefix ?? DEFAULT_CONSOLE_PREFIX).publicKey,
            )
          : undefined,
      cryptoBound: container.hasBinding?.('agora.crypto') === true,
      authkitBound: authkit.verifier,
      appKey: appKeyValue !== undefined,
      appName: this.consolePartition(config),
      controlPlaneVerifier: config.topology.topology === 'control-plane',
    });
  }

  /**
   * `consoleCommands` with no way to authenticate fails the web process at boot, where the
   * channel would start: a console would otherwise wait for answers that never come. Other
   * processes (ace commands) never start the channel and are left alone.
   */
  private async assertConsoleCommandsAuth(config: ResolvedTelescopeConfig): Promise<void> {
    if (config.consoleCommands === null || this.environment() !== 'web') return;
    const plan = await this.consoleAuthPlan(config);
    if (plan.modes.length === 0) {
      throw new ConsoleAuthConfigError(appUnauthenticatedMessage(plan.notes));
    }
  }

  /**
   * `checks`, `health` and `fleet`: the checks this process runs, its probe routes, the fleet a
   * control plane or a standalone app keeps, and this instance's heartbeat (a tenant sends it with
   * its batches, over the same transport as the entries).
   */
  private async startFleet(config: ResolvedTelescopeConfig): Promise<void> {
    const onError = (what: string) => (error: unknown) =>
      void this.debug(
        `[@adonis-agora/telescope] ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    this.healthChecks =
      config.checks.length > 0
        ? new HealthChecks(config.checks, {
            make: (binding) => this.app.container.make(binding as never) as Promise<unknown>,
          })
        : null;
    const fleetConfig = config.fleet;
    if (fleetConfig.enabled && config.topology.topology !== 'tenant') {
      this.fleet = new FleetRegistry(this.fleetStore(fleetConfig.store), {
        derive: {
          goneAfterIntervals: fleetConfig.goneAfterIntervals,
          restartLoop: fleetConfig.restartLoop,
        },
        retentionMs: fleetConfig.retentionMs,
        onError: onError('the fleet could not store a heartbeat'),
      });
      this.fleet.startPruning();
    }
    const environment = (this.app as { getEnvironment?(): string }).getEnvironment?.() ?? 'unknown';
    const startReporter = async (role: string, state: InstanceState): Promise<void> => {
      if (this.reporter !== null) return;
      const appRoot = (this.app as { appRoot?: URL }).appRoot;
      const remote = this.remote;
      const fleet = this.fleet;
      const selfApp = remote === null ? await resolveSelfApp(fleetConfig.app, appRoot) : null;
      let stackCache: StackEntry[] | undefined;
      this.reporter = new InstanceReporter({
        intervalMs: fleetConfig.intervalMs,
        host: fleetConfig.host,
        // A worker serves no HTTP: discovery must not route other apps to it.
        url: environment === 'console' ? null : fleetConfig.url,
        role,
        state,
        version: () => resolveVersion(fleetConfig.version, appRoot),
        checks: this.healthChecks,
        // So a control plane knows which entry types this app records at all.
        watchers: getEnabledWatchers,
        // What the app runs on, read once from its config (databases, Redis, lib descriptors).
        stack: () => {
          stackCache ??= describeStack(this.app.config as never);
          return stackCache;
        },
        ...(remote !== null ? { shipping: () => remote.shippingStats() } : {}),
        send: (heartbeat) => {
          if (remote !== null) remote.heartbeat(heartbeat);
          else if (fleet !== null && selfApp !== null) return fleet.beat(selfApp, heartbeat);
        },
        onError: onError('the heartbeat failed'),
      });
      this.reporter.start();
      setTelescopeFleet({
        fleet: this.fleet,
        healthChecks: this.healthChecks,
        reporter: this.reporter,
        selfApp,
      });
    };
    if (fleetConfig.enabled && environment === 'console') {
      // `node ace <command>`: whether it reports depends on the command, known once ace runs it.
      // The app has booted by then: a worker is ready as soon as its command starts.
      await this.onAceCommand(async (command) => {
        const role = reportingRole(fleetConfig, environment, command);
        if (role === null) return;
        await startReporter(role, 'ready');
        this.drainOnSignal();
      });
    } else if (fleetConfig.enabled) {
      const role = reportingRole(fleetConfig, environment);
      if (role !== null) await startReporter(role, 'starting');
    }
    setTelescopeFleet({
      fleet: this.fleet,
      healthChecks: this.healthChecks,
      reporter: this.reporter,
    });
    const probes = config.health;
    // A console process (an ace worker) serves no HTTP: its checks ride its heartbeat only.
    const serves = environment !== 'console' && environment !== 'repl';
    if (serves && (probes.readiness !== null || probes.liveness !== null)) {
      const runtime = getTelescopeRuntime();
      if (probes.readiness !== null) runtime.probePaths.add(probes.readiness);
      if (probes.liveness !== null) runtime.probePaths.add(probes.liveness);
      const router = (await this.app.container.make('router')) as unknown as ProbeRouter;
      registerProbeRoutes(router, probes, () => ({
        checks: this.healthChecks,
        state: this.reporter?.currentState ?? 'ready',
      }));
    }
  }

  /**
   * A worker drains from the shutdown signal on, like the HTTP server, while its command finishes
   * what it runs (`durable:work` drains its executions before it terminates the app). Only
   * observes the signal: a command that does not handle it still exits as it would without us.
   */
  private drainOnSignal(): void {
    if (this.stopDrainOnSignal !== null) return;
    const stop = observeShutdownSignals(() => {
      void this.reporter?.setState('draining').catch(() => {});
    });
    this.stopDrainOnSignal = () => {
      stop();
      this.stopDrainOnSignal = null;
    };
  }

  /**
   * Call `handler` with the main ace command, right before it runs (`node ace durable:work`).
   * Nothing happens outside ace (no `ace` kernel bound).
   */
  private async onAceCommand(
    handler: (command: ReportingCommand) => Promise<void> | void,
  ): Promise<void> {
    let kernel: AceKernelLike | undefined;
    try {
      kernel = (await this.app.container.make('ace' as never)) as AceKernelLike | undefined;
    } catch {
      return;
    }
    if (kernel === undefined || typeof kernel.executing !== 'function') return;
    kernel.executing(async (command, isMain) => {
      if (!isMain) return;
      const ctor = (command as { constructor?: AceCommandClassLike }).constructor;
      const name = ctor?.commandName;
      if (typeof name !== 'string' || name === '') return;
      const staysAlive =
        (command as { staysAlive?: unknown }).staysAlive ?? ctor?.options?.staysAlive;
      try {
        await handler({ name, staysAlive: staysAlive === true });
      } catch {
        // Reporting must never keep a command from running.
      }
    });
  }

  /** `fleet.store`: a table next to a Lucid entries store (`'auto'`), memory, or a given store. */
  private fleetStore(choice: 'auto' | 'memory' | FleetStore): FleetStore {
    if (typeof choice === 'object') return choice;
    if (choice === 'auto') {
      const local = this.localStore as
        | (TelescopeStore & { hot?: unknown; connectionInfo?: unknown })
        | null;
      const candidate = (local?.hot ?? local) as {
        connectionInfo?: () => {
          db: ConstructorParameters<typeof LucidFleetStore>[0];
          schema: string | undefined;
          autoCreateTable: boolean;
        };
      } | null;
      if (candidate !== null && typeof candidate.connectionInfo === 'function') {
        const info = candidate.connectionInfo();
        return new LucidFleetStore(info.db, {
          ...(info.schema !== undefined ? { schema: info.schema } : {}),
          autoCreateTable: info.autoCreateTable,
        });
      }
    }
    return new MemoryFleetStore();
  }

  /**
   * `topology: 'tenant'`: entries go to the control plane through a {@link RemoteTelescopeStore}
   * (the innermost store, so redaction, sampling and tenant tags apply before an entry is sent).
   * With `tenant.local` they are also kept in that local store, which the app's console reads.
   */
  private applyTopology(
    local: TelescopeStore | null,
    config: ResolvedTelescopeConfig,
  ): TelescopeStore {
    if (config.topology.topology !== 'tenant') return local ?? new InMemoryTelescopeStore();
    const { tenant, buffer, transport } = config.topology;
    // Built at boot; the driver's peer is imported only now. A channel that cannot be built (a
    // missing package, no connection) is logged once; entries stay buffered and every send says why.
    const channel = transport.tenant({
      app: this.app as unknown as NonNullable<TransportContext['app']>,
      timeoutMs: buffer.timeoutMs,
      logger: { warn: (message) => void this.warn(message) },
    });
    channel.catch(
      (error: unknown) =>
        void this.warn(
          `[@adonis-agora/telescope] the ${transport.describe()} transport could not start: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
    this.remote = new RemoteTelescopeStore({
      channel,
      partition: tenant.partition,
      token: tenant.token,
      relay: tenant.relay === true,
      buffer,
      tee: local,
    });
    return this.remote;
  }

  /** `topology: 'control-plane'`: `POST <path>/ingest` and `GET <path>/whoami`. */
  private async registerIngest(config: ResolvedTelescopeConfig): Promise<void> {
    if (config.topology.topology !== 'control-plane') return;
    const { verifyTenant, ingest } = config.topology;
    let logger: { warn(message: string): void } | null = null;
    try {
      logger = (await this.app.container.make('logger')) as { warn(message: string): void };
    } catch {
      // No logger: refusals are not logged.
    }
    const fleet = this.fleet;
    const handler = createIngestHandler({
      verifyTenant,
      store: () => getTelescopeRuntime().store,
      limits: ingest,
      ...(fleet !== null
        ? {
            onHeartbeat: async (verified, heartbeat) => {
              await fleet.beat(verified.partition, heartbeat, verified.environment ?? null);
              this.discoveryPublisher?.poke();
            },
          }
        : {}),
      onRefused: (reason, verified) =>
        logger?.warn(
          `[@adonis-agora/telescope] ingest refused (${reason})${verified ? ` for app ${JSON.stringify(verified.partition)}` : ''}`,
        ),
    });
    // The HTTP routes stay mounted whatever the transport: tenants on HTTP and on a broker can
    // share this control plane, and `whoami` keeps answering.
    const router = (await this.app.container.make('router')) as unknown as IngestRouter;
    this.discoveryPublisher =
      fleet !== null
        ? new DiscoveryPublisher({
            instances: () => fleet.instances(),
            goneAfterIntervals: fleet.deriveOptions.goneAfterIntervals,
          })
        : null;
    registerIngestRoutes(router, handler, ingest, this.discoveryPublisher);
    const transport = config.topology.transport;
    if (transport !== null) {
      // A broker that cannot be reached or built (a missing package, a bad connection name) is
      // logged, never fatal: the HTTP routes above keep serving HTTP tenants and the console.
      let consumer: ControlPlaneChannel | null = null;
      try {
        consumer = await transport.controlPlane({
          app: this.app as unknown as NonNullable<TransportContext['app']>,
          ...(logger ? { logger } : {}),
        });
        await consumer?.start((raw) => handler.message(raw));
      } catch (error) {
        logger?.warn(
          `[@adonis-agora/telescope] the ${transport.describe()} consumer did not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.consumer = consumer;
    }
  }

  /** Warn through the app logger when one is bound. Never throws. */
  private async warn(message: string): Promise<void> {
    try {
      const logger = (await this.app.container.make('logger')) as { warn(msg: string): void };
      logger.warn(message);
    } catch {
      // No logger.
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
  private async registerSchemaCheck(store: TelescopeStore | null): Promise<void> {
    if (store === null) return;
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
  private async buildStore(config: ResolvedTelescopeConfig): Promise<TelescopeStore | null> {
    // A tenant keeps entries locally only when `tenant.local` names a store.
    if (config.topology.topology === 'tenant') {
      const local = config.topology.tenant.local;
      return local === undefined ? null : this.buildNamedStore(local, config);
    }
    if (typeof config.store !== 'string') return config.store;
    return this.buildNamedStore(config.store, config);
  }

  private async buildNamedStore(
    name: string,
    config: ResolvedTelescopeConfig,
  ): Promise<TelescopeStore> {
    const provider = config.stores[name];
    if (provider) return provider({ app: this.app });

    if (name === 'memory') {
      return new InMemoryTelescopeStore({ maxEntries: config.maxEntries });
    }

    const key = config.topology.topology === 'tenant' ? 'tenant.local' : 'config.store';
    throw new Error(
      `@adonis-agora/telescope: ${key} is "${name}", but config.stores.${name} is not defined`,
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
      allow: config.redact.allow,
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
      setOtelSpanReader(otel.readActiveOtelSpan);
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
    this.stopConsoleCommands?.();
    this.stopConsoleCommands = null;
    await this.discovery?.stop();
    this.discovery = null;
    await this.discoveryPublisher?.close();
    this.discoveryPublisher = null;
    this.stopPropagation?.();
    this.stopPropagation = null;
    // Draining first: a tenant's last heartbeat goes out with the final flush below.
    this.stopDrainOnSignal?.();
    await this.reporter?.setState('draining').catch(() => {});
    this.reporter?.stop();
    this.reporter = null;
    this.fleet?.stop();
    this.fleet = null;
    this.healthChecks = null;
    await this.flushRemote();
    await this.consumer?.close().catch(() => {});
    this.consumer = null;
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
      setOtelSpanReader(null);
      setTelescopeWorkWrapper(null);
    }
    this.otelReaderInstalled = false;
    this.unsubscribePrometheus?.();
    this.unsubscribePrometheus = null;
    this.otelMetricsExporter?.shutdown();
    this.otelMetricsExporter = null;
    resetTelescopeRuntime();
  }

  /** A tenant sends what is still buffered before the process exits (best effort, 5 s at most). */
  private async flushRemote(): Promise<void> {
    const stores = [...activeRemoteStores];
    if (stores.length === 0) return;
    await Promise.race([
      Promise.allSettled(stores.map((store) => store.flush())),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
    await Promise.allSettled(stores.map((store) => store.close()));
    this.remote = null;
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
