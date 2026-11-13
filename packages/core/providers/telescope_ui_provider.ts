import type { ApplicationService } from '@adonisjs/core/types';
import { resolveConfig as resolveTelescopeConfig } from '../src/define_config.js';
import {
  devToolsDecisionOf,
  registerTelescopeDevTools,
} from '../src/dev_tools/telescope_dev_tools.js';
import { scopedTelescopeTools } from '../src/dev_tools/telescope_tools.js';
import type { Entry } from '../src/entry.js';
import { getTelescopeRuntime, setTelescopeSelfPath } from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';
import { streamEntries } from '../src/stream/stream_handler.js';
import { TenantScopedStore } from '../src/tenancy_store.js';
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
import { enforceGuardDecision } from '../src/ui/guard.js';
import type { SseSink, UiHttpContext } from '../src/ui/http.js';
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

  /** Log a warning through the app logger when one is bound, else the console. Never throws. */
  private async warn(message: string): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(message);
    } catch {
      console.warn(message);
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

    const coreConfig = resolveTelescopeConfig(this.app.config.get('telescope', {}));

    // Every console API over one store: the full store, or a tenant-scoped view of it. The same
    // builder backs the `telescope:*` ace commands.
    const buildApis = (source: TelescopeStore) =>
      buildConsoleApis(source, {
        coreConfig,
        uiConfig: config,
        container: { make: (token) => this.app.container.make(token as never) },
        audit: (record) => this.auditAction(store, record),
      });
    const shared = buildApis(store);
    const scopedApis = new Map<string, ReturnType<typeof buildApis>>();
    const apisFor = (tags: string[] | null) => {
      if (tags === null) return shared;
      const key = [...tags].sort().join('\n');
      let apis = scopedApis.get(key);
      if (apis === undefined) {
        apis = buildApis(new TenantScopedStore(store, tags));
        if (scopedApis.size >= 64) scopedApis.delete(scopedApis.keys().next().value as string);
        scopedApis.set(key, apis);
      }
      return apis;
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

    // The one gate every API route runs: `authorize` writes the 401/403 JSON on denial. With
    // tenancy on it also decides which organizations this request reads (`?tenant=` narrows it),
    // and hands back the APIs over that slice of the store.
    const gate = async (ctx: UiHttpContext) => {
      const decision = await enforceGuardDecision(ctx, guard);
      if (decision === null) return null;
      const scope = consoleTenantScope(decision, coreConfig.tenancy);
      const selected = selectTenantScope(scope, ctx.request.qs().tenant, coreConfig.tenancy);
      if (selected.forged) {
        void this.warnLog(
          `[@adonis-agora/telescope] console request for organization ${JSON.stringify(String(ctx.request.qs().tenant))} outside the viewer's scope (${callerOf(ctx).id}); answered empty.`,
        );
      }
      return { ...apisFor(selected.tags), scope, selected };
    };
    /** `403` for an action that reaches every organization, asked by a viewer limited to some. */
    const refuseRestricted = (ctx: UiHttpContext) =>
      ctx.response.status(403).send({
        error: 'This action reaches every organization: it needs access to all of them.',
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
        return a.profilesApi.status(ctx);
      })
      .as('telescope_ui.profiles_status');

    router
      .get(`${apiBase}/profiles`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.profilesApi.list(ctx);
      })
      .as('telescope_ui.profiles');

    router
      .get(`${apiBase}/profiles/:id`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.profilesApi.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.profile');

    // A MUTATION (real CPU overhead), so — like replay — it stays behind its own default-deny gate
    // (`telescope_ui.cpuProfiling.armEnabled`) on top of the read guard.
    router
      .post(`${apiBase}/profiles/arm`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.selected.restricted) return refuseRestricted(ctx);
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
        return a.schedulesApi.live(ctx);
      })
      .as('telescope_ui.schedules_live');

    // Live Queue Manager (additive): read routes registered unconditionally (like `profiles/*`);
    // `QueueManagerApi` itself 404s when the capability isn't enabled/configured.
    router
      .get(`${apiBase}/queues/live`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.queueManagerApi.list(ctx, config.queueActions.enabled);
      })
      .as('telescope_ui.queues_live');

    router
      .get(`${apiBase}/queues/live/:queue/jobs/:id`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return a.queueManagerApi.job(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_job');

    // Job/queue MUTATIONS: real actions against real jobs, so — like replay/arm — they stay behind
    // their own default-deny gate (`telescope_ui.queueActions.enabled`) on top of the read guard.
    router
      .post(`${apiBase}/queues/live/:queue/jobs/:id/retry`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.selected.restricted) return refuseRestricted(ctx);
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
        return a.queueManagerApi.retry(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_retry');

    router
      .post(`${apiBase}/queues/live/:queue/enqueue`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        if (a.selected.restricted) return refuseRestricted(ctx);
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
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
          // Counters over every organization: not for a viewer limited to some.
          if (a.selected.restricted) return refuseRestricted(ctx);
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
          const tags = a.selected.tags;
          const session = streamEntries(
            entryEvents,
            sink,
            tags !== null
              ? { filter: (entry: Entry) => entry.tags.some((t) => tags.includes(t)) }
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
          return a.extApi?.data(ctx, String(ctx.params.ext), String(ctx.params.provider));
        })
        .as('telescope_ui.ext_data');

      // Extension actions (a write): behind the same `authorize`, refused without an explicit
      // `confirmed: true`, audited.
      router
        .post(`${apiBase}/ext/:ext/actions/:action`, async (ctx: GuardedContext) => {
          const a = await gate(ctx);
          if (a === null) return;
          if (a.selected.restricted) return refuseRestricted(ctx);
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

    // `GET <path>/api/tenants` — what the console's organization picker shows.
    router
      .get(`${apiBase}/tenants`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return ctx.response
          .status(200)
          .header('cache-control', 'private, no-store')
          .send({ data: await describeTenantScope(a.scope, coreConfig.tenancy, store) });
      })
      .as('telescope_ui.tenants');

    // `GET <path>/api/meta` — always registered (unlike the extension-only routes above), because
    // the dashboard's `ai.enabled` flag lives here too. `entryTypes`/`dashboards` are empty when no
    // extension registry booted; the client already treats a 404 here as "nothing contributed", so
    // registering this unconditionally is purely additive.
    router
      .get(`${apiBase}/meta`, async (ctx: GuardedContext) => {
        const a = await gate(ctx);
        if (a === null) return;
        return ctx.response
          .status(200)
          .header('content-type', 'application/json')
          .send({ data: consoleMeta(a) });
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
