import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { resolveConfig as resolveTelescopeConfig } from '../src/define_config.js';
import type { ExtensionContext } from '../src/extension/types.js';
import { getTelescopeRuntime } from '../src/registry.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { streamEntries } from '../src/stream/stream_handler.js';
import { TelescopeApi } from '../src/ui/api.js';
import { performLogin } from '../src/ui/auth.js';
import {
  clearSessionCookie,
  enforceDashboardAuth,
  writeSessionCookie,
} from '../src/ui/dashboard_auth.js';
import {
  type ResolvedTelescopeUiConfig,
  resolveConfig,
  type TelescopeUiConfig,
} from '../src/ui/define_config.js';
import { DiagnosisApi } from '../src/ui/diagnosis_api.js';
import { ExtensionApi } from '../src/ui/extension_api.js';
import { enforceGuard } from '../src/ui/guard.js';
import type { SseSink, UiHttpContext } from '../src/ui/http.js';
import { renderLoginPage } from '../src/ui/login_page.js';
import { ProfilesApi } from '../src/ui/profiles_api.js';
import { QueueManagerApi } from '../src/ui/queue_manager_api.js';
import { SchedulesApi } from '../src/ui/schedules_api.js';

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

  /** Warn once so a throwing `login` hook doesn't spam the logs on every failed attempt. */
  private warnedOnHookThrow = false;

  private resolve(): ResolvedTelescopeUiConfig {
    return resolveConfig(
      this.app.config.get<TelescopeUiConfig | undefined>('telescope_ui', undefined),
    );
  }

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;

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
    const service = new TelescopeService(store);
    const api = new TelescopeApi(
      service,
      {
        ...(coreConfig.nPlusOne.enabled
          ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold }
          : {}),
      },
      // Request replay (additive): off unless the host opts in via telescope_ui config.
      {
        enabled: config.replay.enabled,
        ...(config.replay.port !== undefined ? { port: config.replay.port } : {}),
        ...(config.replay.timeoutMs !== undefined ? { timeoutMs: config.replay.timeoutMs } : {}),
      },
      // Pulse rollup options from core `config.telescope.pulse`.
      {
        windowMs: coreConfig.pulse.windowMs,
        topN: coreConfig.pulse.topN,
        buckets: coreConfig.pulse.buckets,
        slowRouteMs: coreConfig.pulse.slowRouteMs,
        cards: coreConfig.pulse.cards,
        ...(coreConfig.nPlusOne.enabled
          ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold }
          : {}),
      },
      // Retention/sampling posture (additive) from core `config.telescope.prune`/`sampling`.
      { prune: coreConfig.prune, sampling: coreConfig.sampling },
    );
    // AI exception diagnosis (additive): reads the coordinator the AI provider publishes at
    // `register()` time — `null` when `@adonis-agora/telescope/ai` isn't installed/configured, in
    // which case `DiagnosisApi` degrades every call to a 404 rather than throwing.
    const diagnosisApi = new DiagnosisApi(service, getTelescopeRuntime().diagnosisCoordinator);

    // CPU profiling (additive): reads the `ProfilerService` the `cpu_profiling` provider publishes
    // at `register()` time — `null` when `@adonis-agora/telescope/cpu_profiling` isn't installed/
    // enabled, in which case `ProfilesApi` degrades every call to a 404 rather than throwing.
    const profilesApi = new ProfilesApi(service, getTelescopeRuntime().cpuProfiler);

    // Live Queue Manager (additive): reads the driver the `queue-manager` watcher publishes at
    // `boot()` time — `null` when not enabled/configured, in which case `QueueManagerApi` degrades
    // every call to a 404.
    const queueManagerApi = new QueueManagerApi(getTelescopeRuntime().queueManager);

    // Live Schedules (additive): reads the registry `registerSchedule()` maintains directly (not
    // through the runtime slot — the registry lives on the `ScheduleWatcher` module itself, exactly
    // like `recordScheduledRun`/`scheduleTask`), joined with each schedule's most recent run.
    const schedulesApi = new SchedulesApi(service);

    const apiBase = `${config.path}/api`;

    const router = await this.app.container.make('router');
    const guard = config.authorize;
    const auth = config.dashboardAuth;

    // Composed guard: the existing `authorize` hook FIRST (writes 401/403 on denial), then — only
    // when `dashboardAuth` is configured — the signed-session guard (a missing/invalid session on an
    // API request is a plain 401). When `dashboardAuth` is omitted `auth` is null, so this is exactly
    // `enforceGuard` and behavior is byte-for-byte unchanged.
    const gate = async (ctx: UiHttpContext): Promise<boolean> => {
      if (!(await enforceGuard(ctx, guard))) return false;
      if (auth === null) return true;
      return enforceDashboardAuth(ctx as unknown as HttpContext, auth, 'api', config.path);
    };

    // Built-in `dashboardAuth` login screen (opt-in). Registered ONLY when configured, so omitting
    // `dashboardAuth` leaves route registration byte-for-byte as it was. These endpoints are public
    // (behind NEITHER guard): they MINT/clear the session the guard checks for, and the login page
    // must stay reachable while unauthenticated — including in production, where the default
    // `authorize` hook would otherwise deny it.
    if (auth !== null) {
      const loginPath = `${config.path}/login`;
      const logoutPath = `${config.path}/logout`;

      // `GET <path>/login` → the server-rendered login page. A static route, so it takes precedence
      // over the SPA's `<path>/*` wildcard in the AdonisJS router. `returnTo`/`error` are read
      // client-side from the query (never server-echoed), so the body is a static template.
      router
        .get(loginPath, async (ctx: HttpContext) => {
          ctx.response.header('content-type', 'text/html; charset=utf-8');
          ctx.response.header('cache-control', 'no-store, must-revalidate');
          return ctx.response.send(renderLoginPage(config.path));
        })
        .as('telescope_ui.login.page');

      // `POST <path>/login` → verify credentials via the host `login` hook and mint the cookie.
      // Uniform `401` on ANY failure (unknown user, wrong password, or a throwing hook) so there is
      // no user-enumeration; a throwing hook is warn-logged once, never surfaced to the client.
      router
        .post(loginPath, async (ctx: HttpContext) => {
          const outcome = await performLogin(auth, ctx.request.body(), config.path);
          if (outcome.kind === 'bad-request') {
            return ctx.response.status(400).json({ error: outcome.message });
          }
          if (outcome.kind === 'unauthorized') {
            if (outcome.hookError !== undefined && !this.warnedOnHookThrow) {
              this.warnedOnHookThrow = true;
              const message =
                outcome.hookError instanceof Error
                  ? outcome.hookError.message
                  : String(outcome.hookError);
              const logger = await this.app.container.make('logger');
              logger.warn(`dashboardAuth login hook threw; treating as denial. ${message}`);
            }
            return ctx.response.status(401).json({ error: outcome.message });
          }
          writeSessionCookie(ctx, auth, outcome.cookieValue);
          return ctx.response.status(200).json({ redirectTo: outcome.redirectTo });
        })
        .as('telescope_ui.login.submit');

      // `GET <path>/logout` → clear the cookie and redirect back to the login page. A plain GET
      // (idempotent, only ever destroys the caller's own session) so a simple `<a href>` works.
      router
        .get(logoutPath, async (ctx: HttpContext) => {
          clearSessionCookie(ctx);
          return ctx.response.redirect().toPath(loginPath);
        })
        .as('telescope_ui.logout');
    }

    // Dashboard page: served by the `@adonis-agora/telescope-ui` SPA provider (it mounts the built
    // Vite app at the prefix root, behind this same `authorize` guard). The legacy self-contained
    // inline-HTML dashboard (`renderDashboard`) is no longer auto-routed here; it remains exported
    // from `@adonis-agora/telescope/ui` for embedding. This provider owns only the JSON API + SSE
    // under `<path>/api/*`, which the SPA consumes.

    // JSON API.
    router
      .get(`${apiBase}/entries`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.list(ctx);
      })
      .as('telescope_ui.entries');

    router
      .get(`${apiBase}/entries/:id`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.entry');

    router
      .get(`${apiBase}/trace/:traceId`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.trace(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.trace');

    router
      .get(`${apiBase}/stats`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.stats(ctx);
      })
      .as('telescope_ui.stats');

    router
      .get(`${apiBase}/retention`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.retention(ctx);
      })
      .as('telescope_ui.retention');

    // Request replay (additive): re-issue a captured request from the dashboard.
    // A MUTATION, so it is a POST and is disabled by default (the handler answers
    // 403 unless telescope_ui `replay.enabled` is set) on top of the read guard.
    router
      .post(`${apiBase}/requests/:id/replay`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.replayRequest(ctx, String(ctx.params.id), localPortOf(ctx));
      })
      .as('telescope_ui.replay');

    // AI exception diagnosis (additive): re-diagnose (or serve the cached diagnosis for) an
    // exception/client_exception entry. A `force=true` query string bypasses the cache. Mirrors the
    // NestJS sibling's `POST telescope/api/exceptions/:id/diagnose` route + response shape.
    router
      .post(`${apiBase}/exceptions/:id/diagnose`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        const force = String(ctx.request.qs().force ?? '') === 'true';
        return diagnosisApi.diagnose(ctx, String(ctx.params.id), force);
      })
      .as('telescope_ui.diagnose');

    // CPU profiling (additive): capture/inspect real V8 CPU profiles. Registered unconditionally
    // (like `diagnose`); `ProfilesApi` itself 404s every route when the feature isn't installed.
    router
      .get(`${apiBase}/profiles/status`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return profilesApi.status(ctx);
      })
      .as('telescope_ui.profiles_status');

    router
      .get(`${apiBase}/profiles`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return profilesApi.list(ctx);
      })
      .as('telescope_ui.profiles');

    router
      .get(`${apiBase}/profiles/:id`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return profilesApi.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.profile');

    // A MUTATION (real CPU overhead), so — like replay — it stays behind its own default-deny gate
    // (`telescope_ui.cpuProfiling.armEnabled`) on top of the read guard.
    router
      .post(`${apiBase}/profiles/arm`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        if (!config.cpuProfiling.armEnabled) {
          return ctx.response.status(403).send({
            error:
              'Arming a CPU capture is disabled (set telescope_ui `cpuProfiling.armEnabled: true`).',
          });
        }
        return profilesApi.arm(ctx, bodyOf(ctx));
      })
      .as('telescope_ui.profiles_arm');

    // Live Schedules (additive): registered schedules + computed next-run, joined with last-run.
    router
      .get(`${apiBase}/schedules/live`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return schedulesApi.live(ctx);
      })
      .as('telescope_ui.schedules_live');

    // Live Queue Manager (additive): read routes registered unconditionally (like `profiles/*`);
    // `QueueManagerApi` itself 404s when the capability isn't enabled/configured.
    router
      .get(`${apiBase}/queues/live`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return queueManagerApi.list(ctx, config.queueActions.enabled);
      })
      .as('telescope_ui.queues_live');

    router
      .get(`${apiBase}/queues/live/:queue/jobs/:id`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return queueManagerApi.job(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_job');

    // Job/queue MUTATIONS: real actions against real jobs, so — like replay/arm — they stay behind
    // their own default-deny gate (`telescope_ui.queueActions.enabled`) on top of the read guard.
    router
      .post(`${apiBase}/queues/live/:queue/jobs/:id/retry`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
        return queueManagerApi.retry(ctx, String(ctx.params.queue), String(ctx.params.id));
      })
      .as('telescope_ui.queues_live_retry');

    router
      .post(`${apiBase}/queues/live/:queue/enqueue`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        if (!config.queueActions.enabled) return queueMutationsDisabled(ctx);
        return queueManagerApi.enqueue(ctx, String(ctx.params.queue), bodyOf(ctx));
      })
      .as('telescope_ui.queues_live_enqueue');

    // Metrics analytics (stats/timeseries/percentiles/traces/waterfall) + N+1.
    router
      .get(`${apiBase}/metrics/stats`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.metricsStats(ctx);
      })
      .as('telescope_ui.metrics_stats');

    router
      .get(`${apiBase}/metrics/timeseries`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.metricsTimeseries(ctx);
      })
      .as('telescope_ui.metrics_timeseries');

    router
      .get(`${apiBase}/metrics/traces`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.metricsTraces(ctx);
      })
      .as('telescope_ui.metrics_traces');

    router
      .get(`${apiBase}/metrics/waterfall/:traceId`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.metricsWaterfall(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_waterfall');

    router
      .get(`${apiBase}/metrics/n-plus-one/:traceId`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        return api.metricsNPlusOne(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_n_plus_one');

    // Pulse — aggregated health rollup. Registered only when enabled in core config.
    if (coreConfig.pulse.enabled) {
      router
        .get(`${apiBase}/metrics/pulse`, async (ctx: GuardedContext) => {
          if (!(await gate(ctx))) return;
          return api.metricsPulse(ctx);
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
          if (!(await gate(ctx))) return;
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
          const session = streamEntries(entryEvents, sink);
          // Hold the response open: never resolve/return a body. Cleanup runs on
          // the socket 'close' event wired into the sink above.
          ctx.response.response.on('close', () => session.close());
        })
        .as('telescope_ui.stream');
    }

    // Extension SDK surface (only when at least one extension contributed a registry at boot).
    const registry = getTelescopeRuntime().registry;
    const extApi = registry
      ? new ExtensionApi(registry, {
          store,
          container: { make: (token) => this.app.container.make(token as never) },
          config: resolveTelescopeConfig(this.app.config.get('telescope', {})),
        } satisfies ExtensionContext)
      : null;

    if (registry) {
      router
        .get(`${apiBase}/ext/:ext/data/:provider`, async (ctx: GuardedContext) => {
          if (!(await gate(ctx))) return;
          return extApi?.data(ctx, String(ctx.params.ext), String(ctx.params.provider));
        })
        .as('telescope_ui.ext_data');
    }

    // `GET <path>/api/meta` — always registered (unlike the extension-only routes above), because
    // the dashboard's `ai.enabled` flag lives here too. `entryTypes`/`dashboards` are empty when no
    // extension registry booted; the client already treats a 404 here as "nothing contributed", so
    // registering this unconditionally is purely additive.
    router
      .get(`${apiBase}/meta`, async (ctx: GuardedContext) => {
        if (!(await gate(ctx))) return;
        const ai = { enabled: diagnosisApi.isConfigured() };
        const profiling = { enabled: profilesApi.isConfigured() };
        const queueManager = { enabled: queueManagerApi.isConfigured() };
        if (extApi) return extApi.meta(ctx, { ai, profiling, queueManager });
        return ctx.response
          .status(200)
          .header('content-type', 'application/json')
          .send({ data: { entryTypes: [], dashboards: [], ai, profiling, queueManager } });
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
  return ctx.response
    .status(403)
    .send({ error: 'Queue actions are disabled (set telescope_ui `queueActions.enabled: true`).' });
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
