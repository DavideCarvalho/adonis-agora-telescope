import type { ApplicationService } from '@adonisjs/core/types';
import {
  resolveConfig as resolveTelescopeConfig,
  type TelescopeConfig,
} from '../src/define_config.js';
import {
  devToolsDecisionOf,
  registerTelescopeDevTools,
} from '../src/dev_tools/telescope_dev_tools.js';
import { scopedTelescopeTools } from '../src/dev_tools/telescope_tools.js';
import type { Entry } from '../src/entry.js';
import {
  CONSOLE_COMMAND_CAPABILITIES,
  telescopeConsoleAllows,
  viewerConsoleCapabilities,
} from '../src/federation/answer.js';
import { authkitUsable, keyCreateFailedLine } from '../src/federation/auto_crypto.js';
import {
  type FederatedApp,
  Federation,
  TraceMergingStore,
  type TraceSource,
} from '../src/federation/federation.js';
import { consoleWatchers } from '../src/fleet/watchers.js';
import {
  getEnabledWatchers,
  getTelescopeRuntime,
  getTenantWatchers,
  setTelescopeSelfPath,
} from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';
import { streamEntries } from '../src/stream/stream_handler.js';
import { entryInScope, scopedStore, scopeKey } from '../src/tenancy_store.js';
import { fillTenantFromAuthkit } from '../src/topology/auto_tenant.js';
import {
  appTag,
  type ConsoleAppScope,
  consoleAppScope,
  describeAppScope,
  hiddenSpansCounter,
  KnownAppsCache,
  knownApps,
  selectAppScope,
  withFederatedApps,
} from '../src/ui/app_scope.js';
import { callerOf } from '../src/ui/caller.js';
import {
  buildConsoleApis,
  consoleMeta,
  QUEUE_ACTIONS_DISABLED,
  recordExtensionAction,
} from '../src/ui/console_apis.js';
import {
  MISSING_AUTHORIZE_WARNING,
  type ResolvedTelescopeUiConfig,
  resolveConfig,
  type TelescopeUiConfig,
} from '../src/ui/define_config.js';
import type { ExtensionActionAudit } from '../src/ui/extension_api.js';
import { appsOfTags } from '../src/ui/fleet_api.js';
import { enforceGuardDecision } from '../src/ui/guard.js';
import type { SseSink, UiHttpContext, UiResponse } from '../src/ui/http.js';
import {
  consoleTenantScope,
  describeTenantScope,
  selectTenantScope,
} from '../src/ui/tenant_scope.js';

/**
 * Wires `@adonis-agora/telescope/ui` into the AdonisJS application.
 *
 * - `boot()` reads `config/telescope_ui.ts`, resolves the live telescope store
 *   from the core runtime slot (no DI — same handle the watchers record through),
 *   and registers routes under the configured prefix via the AdonisJS router:
 *   the dashboard page at the prefix root and the JSON API under `<path>/api/*`.
 *   Every route runs the configured `authorize` guard first.
 *
 * Failures degrade safely: a disabled config or a missing store registers no
 * routes (warn-logged), so the dashboard simply does not exist rather than
 * crashing the host.
 */
export default class TelescopeUiProvider {
  constructor(protected app: ApplicationService) {}

  /** The apps this console reads from their own stores (`apps.federated`). */
  private federation: Federation | null = null;

  async shutdown() {
    this.federation?.close();
    this.federation = null;
  }

  /**
   * Automatic crypto mode with crypto embedded in this console: create the `console-telescope` key
   * in each federated app's partition when missing, at boot (§11). A failure never fails boot: it
   * is logged and retried on the first command.
   */
  private async prepareConsoleKeys(federation: Federation): Promise<void> {
    for (const app of federation.list()) {
      try {
        await app.prepare();
      } catch (error) {
        await this.warn(keyCreateFailedLine(app.partition, error));
      }
    }
  }

  private environment(): string | undefined {
    return (this.app as { getEnvironment?(): string }).getEnvironment?.();
  }

  /** Log a warning through the app logger when one is bound, else the console. Never throws. */
  private async warn(message: string): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(message);
    } catch {
      console.warn(message);
    }
  }

  /** Log at info through the app logger when one is bound. Never throws. */
  private async info(message: string): Promise<void> {
    try {
      const logger = (await this.app.container.make('logger')) as { info(msg: string): void };
      logger.info(message);
    } catch {
      // No logger: nothing to say.
    }
  }

  /** Log a warning through the app logger when one is bound. Never throws. */
  private async warnLog(message: string): Promise<void> {
    try {
      const logger = (await this.app.container.make('logger')) as { warn(msg: string): void };
      logger.warn(message);
    } catch {
      // No logger: nothing to say.
    }
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

  private resolve(): ResolvedTelescopeUiConfig {
    return resolveConfig(
      this.app.config.get<TelescopeUiConfig | undefined>('telescope_ui', undefined),
      { inProduction: this.app.inProduction === true },
    );
  }

  /** Audit one extension action (log line + a `diagnostic` entry). */
  private async auditAction(store: TelescopeStore, record: ExtensionActionAudit): Promise<void> {
    let logger: { info(obj: unknown, msg?: string): void } | null = null;
    try {
      logger = (await this.app.container.make('logger')) as unknown as typeof logger;
    } catch {
      // No logger: the entry is the record.
    }
    await recordExtensionAction(store, record, logger);
  }

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;
    // Without `authorize` the console is open outside production and denies every request in
    // production: say so once, at boot, in every environment.
    if (!config.authorizeConfigured) {
      await this.warn(MISSING_AUTHORIZE_WARNING);
    }

    let store: TelescopeStore | null;
    try {
      store = getTelescopeRuntime().store;
    } catch (err) {
      console.error(
        `TelescopeUiProvider: could not resolve the telescope store: ${asMessage(err)}`,
      );
      return;
    }
    if (store === null) {
      console.warn(
        'TelescopeUiProvider: telescope store is not booted (is @adonis-agora/telescope enabled?); ' +
          'dashboard routes not registered.',
      );
      return;
    }

    const rawCoreConfig = this.app.config.get<TelescopeConfig>('telescope', {});
    await fillTenantFromAuthkit(this.app.container, rawCoreConfig);
    const coreConfig = resolveTelescopeConfig(rawCoreConfig);

    // Every console API over one store: the full store, or a tenant-scoped view of it. The same
    // builder backs the `telescope:*` ace commands.
    const buildApis = (
      source: TelescopeStore,
      hiddenSpans?: (traceId: string) => Promise<number>,
    ) =>
      buildConsoleApis(source, {
        coreConfig,
        uiConfig: config,
        container: { make: (token) => this.app.container.make(token as never) },
        audit: (record) => this.auditAction(store, record),
        ...(hiddenSpans !== undefined ? { hiddenSpans } : {}),
      });
    const shared = buildApis(store);
    // The App picker's list per scope, re-read at most every 30 s (see `GET <path>/api/apps`).
    const knownAppsCache = new KnownAppsCache();
    const scopedApis = new Map<string, ReturnType<typeof buildApis>>();
    const remember = (key: string, build: () => ReturnType<typeof buildApis>) => {
      let apis = scopedApis.get(key);
      if (apis === undefined) {
        apis = build();
        if (scopedApis.size >= 64) scopedApis.delete(scopedApis.keys().next().value as string);
        scopedApis.set(key, apis);
      }
      return apis;
    };

    // Federated apps: read from their own stores, actions sent to them (`apps.federated`).
    const web = this.environment() === 'web';
    const hasFederated =
      config.apps.federated !== undefined && Object.keys(config.apps.federated).length > 0;
    const federation = hasFederated
      ? new Federation(config.apps.federated as NonNullable<typeof config.apps.federated>, {
          app: this.app,
          // The web process sends commands: a federated app it cannot authenticate to fails here.
          strict: web,
          // What authkit's calls between apps actually provide, not just its binding.
          warn: (line) => void this.warn(line),
          info: (line) => void this.info(line),
          onKeyCreated: (partition) =>
            void this.info(
              `[@adonis-agora/telescope] console commands: created the crypto key "console-telescope" in partition ${partition}`,
            ),
          ...(await authkitUsable(this.app.container).then((usable) => ({
            authkitTokens: usable.tokens,
            authkitDirectory: usable.directory,
          }))),
        })
      : null;
    this.federation = federation;
    if (web) {
      for (const app of federation?.list() ?? []) {
        await this.info(
          `[@adonis-agora/telescope] console commands to "${app.id}": ${
            app.authMode === null
              ? `none (${app.browseOnlyNote ?? 'browse-only, commands: false'})`
              : app.authMode
          }`,
        );
      }
      if (federation !== null) await this.prepareConsoleKeys(federation);
    }
    /** The federated apps this viewer may see, as the trace views and Architecture read them. */
    const federatedSources = (
      appScope: ConsoleAppScope,
      tenantTags: string[] | null,
    ): TraceSource[] =>
      federation === null
        ? []
        : federation
            .list()
            .filter((app) => appScope.all || appScope.ids.includes(app.id))
            .map((app) => ({
              id: app.id,
              store: async () => scopedStore(await app.store(), tenantTags, null),
            }));

    // `sources`: federated apps whose spans the trace views merge in (the view is not narrowed
    // to one app).
    const apisFor = (
      tenantTags: string[] | null,
      appTags: string[] | null,
      sources: TraceSource[] = [],
    ) => {
      const key = scopeKey(tenantTags, appTags);
      if (sources.length === 0) {
        if (key === null) return shared;
        return remember(key, () =>
          buildApis(
            scopedStore(store, tenantTags, appTags),
            appTags === null ? undefined : hiddenSpansCounter(store, tenantTags, appTags),
          ),
        );
      }
      return remember(`${key ?? '*'}\u0000traces:${sources.map((s) => s.id).join(',')}`, () =>
        buildApis(
          new TraceMergingStore(scopedStore(store, tenantTags, appTags), sources),
          appTags === null ? undefined : hiddenSpansCounter(store, tenantTags, appTags),
        ),
      );
    };
    /** The APIs over a federated app's store (as this viewer's organizations see it). */
    const federatedApisFor = async (app: FederatedApp, tenantTags: string[] | null) => {
      const source = scopedStore(await app.store(), tenantTags, null);
      return {
        source,
        apis: remember(`federated:${app.id}\u0000${scopeKey(tenantTags, null) ?? '*'}`, () =>
          buildApis(source),
        ),
      };
    };

    // Developer tools over MCP: when the app runs `@adonis-agora/agent/mcp_provider`, telescope's
    // tools are served on its dev endpoint (`/mcp/agora`), behind this console's `authorize`.
    await registerTelescopeDevTools(
      this.app.container,
      (() => {
        const toolsFor = scopedTelescopeTools(store, coreConfig);
        return (ctx: unknown) => toolsFor(devToolsDecisionOf(ctx));
      })(),
      config.authorize,
      (reason) => void this.debug(`[@adonis-agora/telescope] dev tools not registered: ${reason}`),
    );

    const apiBase = `${config.path}/api`;
    // Publish (or clear) the prefix the request middleware skips, so the console
    // stops ranking itself among the app's slowest routes.
    setTelescopeSelfPath(config.recordOwnRequests ? null : config.path);

    const router = await this.app.container.make('router');
    const guard = config.authorize;
    /**
     * Each request's viewer capabilities, from `authorize`: sent with the commands it relays, and
     * applied to this console's own actions too (every console capability when `authorize` names
     * none).
     */
    const viewerCapabilities = new WeakMap<object, string[]>();
    const viewerOf = (ctx: object): string[] => viewerCapabilities.get(ctx) ?? [];
    /** `403` when the viewer lacks `capability` for an action on this console's own app. */
    const viewerLacks = (ctx: UiHttpContext, capability: string): boolean => {
      if (telescopeConsoleAllows(viewerOf(ctx), capability)) return false;
      ctx.response.status(403).send({ error: `The viewer lacks ${capability}.` });
      return true;
    };

    // The one gate every API route runs: `authorize` writes the 401/403 JSON on denial. It also
    // decides which organizations (tenancy on, `?tenant=` narrows) and which apps (`?app=` narrows)
    // this request reads, and hands back the APIs over that slice of the store.
    const gate = async (ctx: UiHttpContext) => {
      const decision = await enforceGuardDecision(ctx, guard);
      if (decision === null) return null;
      viewerCapabilities.set(
        ctx,
        viewerConsoleCapabilities(decision.capabilities, decision.access),
      );
      const qs = ctx.request.qs();
      const scope = consoleTenantScope(decision, coreConfig.tenancy);
      const tenantSelected = selectTenantScope(scope, qs.tenant, coreConfig.tenancy);
      if (tenantSelected.forged) {
        void this.warnLog(
          `[@adonis-agora/telescope] console request for organization ${JSON.stringify(String(qs.tenant))} outside the viewer's scope (${callerOf(ctx).id}); answered empty.`,
        );
      }
      const appScope = consoleAppScope(decision);
      const appSelected = selectAppScope(appScope, qs.app);
      if (appSelected.forged) {
        void this.warnLog(
          `[@adonis-agora/telescope] console request for app ${JSON.stringify(String(qs.app))} outside the viewer's scope (${callerOf(ctx).id}); answered empty.`,
        );
      }
      const selected = {
        tags: tenantSelected.tags,
        appTags: appSelected.tags,
        restricted: tenantSelected.restricted || appSelected.restricted,
        forged: tenantSelected.forged || appSelected.forged,
      };
      const asked =
        typeof qs.app === 'string' && qs.app !== '' && qs.app !== '*' ? qs.app : undefined;
      const federated = appSelected.forged ? undefined : federation?.get(asked);
      if (federated !== undefined) {
        let built: Awaited<ReturnType<typeof federatedApisFor>>;
        try {
          built = await federatedApisFor(federated, tenantSelected.tags);
        } catch (error) {
          ctx.response.status(503).send({
            error: `Could not read ${federated.label}'s telescope store: ${asMessage(error)}`,
          });
          return null;
        }
        return {
          ...built.apis,
          scope,
          appScope,
          selected,
          federated,
          federatedStore: built.source,
          tenantRestricted: tenantSelected.restricted,
        };
      }
      return {
        ...apisFor(
          tenantSelected.tags,
          appSelected.tags,
          // Not narrowed to one app: a trace shows the spans federated apps recorded too.
          asked === undefined ? federatedSources(appScope, tenantSelected.tags) : [],
        ),
        scope,
        appScope,
        selected,
        federated: undefined as FederatedApp | undefined,
        federatedStore: undefined as TelescopeStore | undefined,
        tenantRestricted: tenantSelected.restricted,
      };
    };
    /** `404`: what the console's own process serves (profiles, AI, extensions, the live tail). */
    const notForFederated = (ctx: UiHttpContext, app: FederatedApp, what: string) =>
      ctx.response.status(404).send({
        error: `${what} is not available for ${app.label}: this console reads ${app.label}'s entries from its own store.`,
      });
    /** `403`: an action on a federated app this console only browses. */
    const readOnlyFederated = (ctx: UiHttpContext, app: FederatedApp) =>
      ctx.response.status(403).send({
        error: `${app.label} is federated and read-only here: change it in ${app.label} itself.`,
      });
    /** Run `verb` on the federated app; answer its status and body. */
    const relay = async (
      ctx: UiHttpContext,
      app: FederatedApp,
      verb: string,
      args: unknown[],
    ): Promise<unknown> => {
      const out = await app.run(
        verb,
        args,
        callerOf(ctx).id,
        // Set by `gate` for every request; absent would mean no `authorize` ran: grant nothing.
        viewerCapabilities.get(ctx) ?? [],
      );
      return (ctx.response.status(out.status) as UiResponse)
        .header('content-type', 'application/json')
        .send(out.body);
    };
    /** An action on a federated app: refused when read-only, or when the viewer sees only some organizations. */
    const federatedAction = async (
      ctx: UiHttpContext,
      a: { federated?: FederatedApp | undefined; tenantRestricted: boolean },
      verb: string,
      args: unknown[],
    ): Promise<unknown> => {
      const app = a.federated as FederatedApp;
      if (a.tenantRestricted) return refuseRestricted(ctx);
      if (app.actions === 'none') return readOnlyFederated(ctx, app);
      return relay(ctx, app, verb, args);
    };
    /** `403` for an action that reaches every organization or app, asked by a viewer limited to some. */
    const refuseRestricted = (
      ctx: UiHttpContext,
      a: { selected: { tags: string[] | null; appTags: string[] | null } } | null = null,
    ) =>
      ctx.response.status(403).send({
        error:
          a !== null && a.selected.appTags !== null && a.selected.tags === null
            ? 'This action reaches every app: it needs access to all of them.'
            : 'This action reaches every organization: it needs access to all of them.',
      });

    // Dashboard page: served by the `@adonis-agora/telescope-ui` SPA provider (it mounts the built
    // Vite app at the prefix root, behind this same `authorize` guard). This provider owns only the
    // JSON API + SSE under `<path>/api/*`, which the SPA — or a front end of your own — consumes.

    // JSON API.
    router
      .get(`${apiBase}/entries`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.list(ctx);
      })
      .as('telescope_ui.entries');

    router
      .get(`${apiBase}/entries/:id`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.entry');

    router
      .get(`${apiBase}/trace/:traceId`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.trace(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.trace');

    router
      .get(`${apiBase}/stats`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.stats(ctx);
      })
      .as('telescope_ui.stats');

    router
      .get(`${apiBase}/retention`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.retention(ctx);
      })
      .as('telescope_ui.retention');

    // Request replay (additive): re-issue a captured request from the dashboard.
    // A MUTATION, so it is a POST and is disabled by default (the handler answers
    // 403 unless telescope_ui `replay.enabled` is set) on top of the read guard.
    router
      .post(`${apiBase}/requests/:id/replay`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return federatedAction(ctx, a, 'replay', [String(ctx.params.id)]);
        if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.replay)) return;
        return a.api.replayRequest(ctx, String(ctx.params.id), localPortOf(ctx));
      })
      .as('telescope_ui.replay');

    // AI exception diagnosis (additive): re-diagnose (or serve the cached diagnosis for) an
    // exception/client_exception entry. A `force=true` query string bypasses the cache. Mirrors the
    // NestJS sibling's `POST telescope/api/exceptions/:id/diagnose` route + response shape.
    router
      .post(`${apiBase}/exceptions/:id/diagnose`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return notForFederated(ctx, a.federated, 'AI diagnosis');
        // A diagnosis spends AI tokens and writes a cached result: a change, gated like one.
        if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.write)) return;
        const force = String(ctx.request.qs().force ?? '') === 'true';
        return a.diagnosisApi.diagnose(ctx, String(ctx.params.id), force);
      })
      .as('telescope_ui.diagnose');

    // CPU profiling (additive): capture/inspect real V8 CPU profiles. Registered unconditionally
    // (like `diagnose`); `ProfilesApi` itself 404s every route when the feature isn't installed.
    router
      .get(`${apiBase}/profiles/status`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return notForFederated(ctx, a.federated, 'CPU profiling');
        return a.profilesApi.status(ctx);
      })
      .as('telescope_ui.profiles_status');

    router
      .get(`${apiBase}/profiles`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return notForFederated(ctx, a.federated, 'CPU profiling');
        return a.profilesApi.list(ctx);
      })
      .as('telescope_ui.profiles');

    router
      .get(`${apiBase}/profiles/:id`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return notForFederated(ctx, a.federated, 'CPU profiling');
        return a.profilesApi.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.profile');

    // A MUTATION (real CPU overhead), so — like replay — it stays behind its own default-deny gate
    // (`telescope_ui.cpuProfiling.armEnabled`) on top of the read guard.
    router
      .post(`${apiBase}/profiles/arm`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return notForFederated(ctx, a.federated, 'CPU profiling');
        if (a.selected.restricted) return refuseRestricted(ctx, a);
        if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.write)) return;
        if (!config.cpuProfiling.armEnabled) {
          return ctx.response.status(403).send({
            error:
              'Arming a CPU capture is disabled (set telescope_ui `cpuProfiling.armEnabled: true`).',
          });
        }
        return a.profilesApi.arm(ctx, bodyOf(ctx));
      })
      .as('telescope_ui.profiles_arm');

    // Live Schedules (additive): registered schedules + computed next-run, joined with last-run.
    router
      .get(`${apiBase}/schedules/live`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return relay(ctx, a.federated, 'schedules.live', []);
        return a.schedulesApi.live(ctx);
      })
      .as('telescope_ui.schedules_live');

    // Live Queue Manager (additive): read routes registered unconditionally (like `profiles/*`);
    // `QueueManagerApi` itself 404s when the capability isn't enabled/configured.
    router
      .get(`${apiBase}/queues/live`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) return relay(ctx, a.federated, 'queues.list', []);
        return a.queueManagerApi.list(
          ctx,
          config.queueActions.enabled &&
            telescopeConsoleAllows(viewerOf(ctx), CONSOLE_COMMAND_CAPABILITIES.queues),
        );
      })
      .as('telescope_ui.queues_live');

    router
      .get(`${apiBase}/queues/live/:queue/jobs/:id`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) {
          return relay(ctx, a.federated, 'queues.job', [
            String(ctx.params.queue),
            String(ctx.params.id),
          ]);
        }
        return a.queueManagerApi.job(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_job');

    // Job/queue MUTATIONS: real actions against real jobs, so — like replay/arm — they stay behind
    // their own default-deny gate (`telescope_ui.queueActions.enabled`) on top of the read guard.
    router
      .post(`${apiBase}/queues/live/:queue/jobs/:id/retry`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) {
          return federatedAction(ctx, a, 'queues.retry', [
            String(ctx.params.queue),
            String(ctx.params.id),
          ]);
        }
        if (a.selected.restricted) return refuseRestricted(ctx, a);
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
        if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.queues)) return;
        return a.queueManagerApi.retry(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_retry');

    router
      .post(`${apiBase}/queues/live/:queue/enqueue`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) {
          return federatedAction(ctx, a, 'queues.enqueue', [String(ctx.params.queue), bodyOf(ctx)]);
        }
        if (a.selected.restricted) return refuseRestricted(ctx, a);
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
        if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.queues)) return;
        return a.queueManagerApi.enqueue(ctx, String(ctx.params.queue), bodyOf(ctx));
      })
      .as('telescope_ui.queues_live_enqueue');

    // Metrics analytics (stats/timeseries/percentiles/traces/waterfall) + N+1.
    router
      .get(`${apiBase}/metrics/stats`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsStats(ctx);
      })
      .as('telescope_ui.metrics_stats');

    router
      .get(`${apiBase}/metrics/timeseries`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsTimeseries(ctx);
      })
      .as('telescope_ui.metrics_timeseries');

    router
      .get(`${apiBase}/metrics/traces`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsTraces(ctx);
      })
      .as('telescope_ui.metrics_traces');

    router
      .get(`${apiBase}/metrics/screens`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsScreens(ctx);
      })
      .as('telescope_ui.metrics_screens');

    router
      .get(`${apiBase}/metrics/waterfall/:traceId`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsWaterfall(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_waterfall');

    router
      .get(`${apiBase}/metrics/n-plus-one/:traceId`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsNPlusOne(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_n_plus_one');

    router
      .get(`${apiBase}/metrics/ai`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.api.metricsAi(ctx);
      })
      .as('telescope_ui.metrics_ai');

    // Prometheus scrape of the AI-usage / agent-run metrics (`agora_ai_*`, `agora_agent_*`).
    // Opt-in (core `prometheus.enabled`) and behind the same gate as the JSON API: a scraper
    // authenticates the way any API client does (`authorize`, e.g. `authorizeByToken`). A static route, so it wins over the SPA's `<path>/*` wildcard. The registry is
    // read per request from the runtime slot the core provider fills at boot.
    if (coreConfig.prometheus.enabled) {
      router
        .get(`${config.path}/metrics`, async (ctx: GuardedContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          if (a.federated) return notForFederated(ctx, a.federated, 'The Prometheus scrape');
          // Counters over every organization: not for a viewer limited to some.
          if (a.selected.restricted) return refuseRestricted(ctx, a);
          const registry = getTelescopeRuntime().aiMetrics ?? null;
          if (registry === null) {
            return ctx.response.status(404).send({ error: 'Prometheus metrics are not running.' });
          }
          return ctx.response
            .status(200)
            .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
            .header('cache-control', 'no-store')
            .send(registry.prometheus());
        })
        .as('telescope_ui.prometheus');
    }

    // Pulse — aggregated health rollup. Registered only when enabled in core config.
    if (coreConfig.pulse.enabled) {
      router
        .get(`${apiBase}/metrics/pulse`, async (ctx: GuardedContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          return a.api.metricsPulse(ctx);
        })
        .as('telescope_ui.metrics_pulse');
    }

    // ───────────────────────── SSE live-stream (additive) ─────────────────────────
    // New entries (already redacted + post-sampling) streamed to the dashboard as
    // they arrive. Registered only when the entry-events bus is live (core
    // `config.telescope.stream.enabled !== false`).
    const entryEvents = getTelescopeRuntime().entryEvents;
    if (entryEvents) {
      router
        .get(`${apiBase}/stream`, async (ctx: StreamContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          if (a.federated) return notForFederated(ctx, a.federated, 'The live tail');
          const raw = ctx.response.response;
          raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const sink: SseSink = {
            write: (chunk) => raw.write(chunk),
            onClose: (handler) => ctx.request.request.on('close', handler),
          };
          const { tags, appTags } = a.selected;
          const session = streamEntries(
            entryEvents,
            sink,
            tags !== null || appTags !== null
              ? { filter: (entry: Entry) => entryInScope(entry, tags, appTags) }
              : {},
          );
          // Hold the response open: never resolve/return a body. Cleanup runs on
          // the socket 'close' event wired into the sink above.
          ctx.response.response.on('close', () => session.close());
        })
        .as('telescope_ui.stream');
    }

    if (getTelescopeRuntime().registry) {
      router
        .get(`${apiBase}/ext/:ext/data/:provider`, async (ctx: GuardedContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          if (a.federated) return notForFederated(ctx, a.federated, 'Extension data');
          return a.extApi?.data(ctx, String(ctx.params.ext), String(ctx.params.provider));
        })
        .as('telescope_ui.ext_data');

      // Extension actions (a write): behind the same `authorize`, refused without an explicit
      // `confirmed: true`, audited.
      router
        .post(`${apiBase}/ext/:ext/actions/:action`, async (ctx: GuardedContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          if (a.federated) return notForFederated(ctx, a.federated, 'Extension actions');
          if (a.selected.restricted) return refuseRestricted(ctx, a);
          if (viewerLacks(ctx, CONSOLE_COMMAND_CAPABILITIES.write)) return;
          return a.extApi?.action(
            ctx,
            String(ctx.params.ext),
            String(ctx.params.action),
            bodyOf(ctx),
            callerOf(ctx),
          );
        })
        .as('telescope_ui.ext_action');
    }

    // `GET <path>/api/fleet` — the fleet: instances per app (up / starting / draining / gone),
    // deploys, restart loops and failing checks with the exceptions since. The apps the viewer may
    // see (`?app=` narrows); hidden from a viewer limited to some organizations (instances are
    // shared by all of them).
    router
      .get(`${apiBase}/fleet`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.fleetApi.fleet(ctx, {
          apps: appsOfTags(a.selected.appTags),
          hidden: a.scope !== null && !a.scope.all,
        });
      })
      .as('telescope_ui.fleet');

    // `GET <path>/api/architecture?window=1h|6h|24h` — the apps and what links them: the calls
    // between them in the window, and (with authkit-server in this process) who may call whom.
    router
      .get(`${apiBase}/architecture`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        const hidden = a.scope !== null && !a.scope.all;
        const sources = hidden ? [] : federatedSources(a.appScope, a.selected.tags);
        if (a.federated) {
          // The graph is about links between apps: a federated app is shown among every app the
          // viewer may see, read from this console's entries and each federated app's own.
          const viewerTags = a.appScope.all ? null : a.appScope.ids.map(appTag);
          return apisFor(a.selected.tags, viewerTags).fleetApi.architecture(
            ctx,
            { apps: appsOfTags(viewerTags), hidden },
            sources,
          );
        }
        return a.fleetApi.architecture(
          ctx,
          { apps: appsOfTags(a.selected.appTags), hidden },
          sources,
        );
      })
      .as('telescope_ui.architecture');

    // `GET <path>/api/health` — this process's health checks, run now (cached per check).
    router
      .get(`${apiBase}/health`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated && !(a.scope !== null && !a.scope.all)) {
          return relay(ctx, a.federated, 'health', []);
        }
        return a.fleetApi.health(ctx, a.scope !== null && !a.scope.all);
      })
      .as('telescope_ui.health');

    // `GET <path>/api/tenants` — what the console's organization picker shows.
    router
      .get(`${apiBase}/tenants`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return ctx.response
          .status(200)
          .header('cache-control', 'private, no-store')
          .send({
            data: await describeTenantScope(a.scope, coreConfig.tenancy, a.federatedStore ?? store),
          });
      })
      .as('telescope_ui.tenants');

    // `GET <path>/api/apps` — what the console's App picker shows: the apps this viewer may see
    // (within the organizations it may see).
    router
      .get(`${apiBase}/apps`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        const source = scopedStore(store, a.selected.tags, null);
        // On a control plane the fleet knows every app that reports, quiet ones included; it is
        // hidden from a viewer limited to some organizations (instances are shared by all).
        const fleet = getTelescopeRuntime().fleet;
        const sources =
          fleet !== null &&
          coreConfig.topology.topology === 'control-plane' &&
          !(a.scope !== null && !a.scope.all)
            ? [async () => (await fleet.instances(null)).map((instance) => instance.app)]
            : [];
        const known = () =>
          knownAppsCache.get(
            `${sources.length}\u0000${scopeKey(a.selected.tags, null) ?? '*'}`,
            () => knownApps(source, { sources }),
          );
        const description = await describeAppScope(a.appScope, source, config.apps.labels, known);
        const qsApp = ctx.request.qs().app;
        return ctx.response
          .status(200)
          .header('cache-control', 'private, no-store')
          .send({
            data: withFederatedApps(
              description,
              a.appScope,
              (federation?.list() ?? []).map((app) => ({
                id: app.id,
                label: app.label,
                actions: app.actions,
              })),
              {
                controlPlane: coreConfig.topology.topology === 'control-plane',
                ...(config.apps.localLabel !== undefined
                  ? { localLabel: config.apps.localLabel }
                  : {}),
                selected: typeof qsApp === 'string' && qsApp !== '' && qsApp !== '*' ? qsApp : null,
              },
            ),
          });
      })
      .as('telescope_ui.apps');

    // On a control plane the entries come from the tenants, so "is the `query` watcher on" is a
    // question about them: the union of what the instances of the apps in view report. A
    // standalone app answers with its own watchers (`{}` keeps that default).
    const controlPlaneWatchers = (appTags: string[] | null) =>
      consoleWatchers({
        controlPlane: coreConfig.topology.topology === 'control-plane',
        fleet: getTelescopeRuntime().fleet,
        apps: appsOfTags(appTags),
        since: Date.now() - (coreConfig.prune.enabled ? coreConfig.prune.afterMs : 86_400_000),
        own: getEnabledWatchers,
        forTenants: getTenantWatchers,
      });

    // `GET <path>/api/meta` — always registered (unlike the extension-only routes above), because
    // the dashboard's `ai.enabled` flag lives here too. `entryTypes`/`dashboards` are empty when no
    // extension registry booted; the client already treats a 404 here as "nothing contributed", so
    // registering this unconditionally is purely additive.
    router
      .get(`${apiBase}/meta`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.federated) {
          // What this process runs (AI, profiles, extensions) is not the federated app's; its
          // queue console is there when it answers commands. Its watchers are unknown here.
          const meta = consoleMeta(a, { watchers: null });
          return ctx.response
            .status(200)
            .header('content-type', 'application/json')
            .send({
              data: {
                ...meta,
                entryTypes: [],
                dashboards: [],
                ...(meta.actions !== undefined ? { actions: [] } : {}),
                ai: { enabled: false },
                profiling: { enabled: false },
                queueManager: { enabled: a.federated.actions === 'app' },
                federated: { app: a.federated.id, actions: a.federated.actions },
                viewer: { capabilities: viewerOf(ctx) },
              },
            });
        }
        return ctx.response
          .status(200)
          .header('content-type', 'application/json')
          .send({
            data: {
              ...consoleMeta(a, await controlPlaneWatchers(a.selected.appTags)),
              viewer: { capabilities: viewerOf(ctx) },
            },
          });
      })
      .as('telescope_ui.meta');
  }
}

/** The AdonisJS `HttpContext` slice the route handlers touch (structural). */
interface GuardedContext extends UiHttpContext {
  params: Record<string, unknown>;
}

/**
 * The AdonisJS `HttpContext` slice the SSE stream route needs: the raw Node
 * request/response under `ctx.request.request` / `ctx.response.response`, used to
 * write `text/event-stream` chunks and observe the socket `close` event.
 */
interface StreamContext extends UiHttpContext {
  request: UiHttpContext['request'] & {
    request: { on(event: 'close', handler: () => void): void };
  };
  response: UiHttpContext['response'] & {
    response: {
      writeHead(status: number, headers: Record<string, string>): void;
      write(chunk: string): void;
      on(event: 'close', handler: () => void): void;
    };
  };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the parsed JSON body off a real Adonis `HttpContext`'s request. `UiRequest` (the
 * framework-light interface these routes are typed against) deliberately has no `body()` — every
 * OTHER route here takes its parameters from the URL/query string — so this reads it structurally
 * off the real `ctx` the router hands in, the same "cast down to what we actually need" pattern
 * {@link localPortOf} uses for the raw socket.
 */
function bodyOf(ctx: GuardedContext): Record<string, unknown> {
  const body: unknown = (ctx as unknown as { request: { body?(): unknown } }).request.body?.();
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** `403` for a queue mutation route when `telescope_ui.queueActions.enabled` is not set. */
function queueMutationsDisabled(ctx: GuardedContext): unknown {
  return ctx.response.status(403).send({ error: QUEUE_ACTIONS_DISABLED });
}

/**
 * Read the incoming request's local TCP port — the port the dashboard is actually
 * served on — off the raw Node socket (`ctx.request.request.socket.localPort`), so
 * a replay targets the same live server it was triggered from rather than a guessed
 * default. Returns `undefined` when the socket isn't reachable (e.g. a synthetic
 * test context), leaving replay to fall back to the configured `replay.port`, then
 * `PORT`, then 3333 (the AdonisJS default).
 */
function localPortOf(ctx: GuardedContext): number | undefined {
  const port = (ctx as { request?: { request?: { socket?: { localPort?: unknown } } } }).request
    ?.request?.socket?.localPort;
  return typeof port === 'number' && port > 0 ? port : undefined;
}
