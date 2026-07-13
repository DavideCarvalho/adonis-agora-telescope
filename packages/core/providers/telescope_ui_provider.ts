import type { ApplicationService } from '@adonisjs/core/types';
import { resolveConfig as resolveTelescopeConfig } from '../src/define_config.js';
import type { ExtensionContext } from '../src/extension/types.js';
import { getTelescopeRuntime } from '../src/registry.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { streamEntries } from '../src/stream/stream_handler.js';
import { TelescopeApi } from '../src/ui/api.js';
import { renderDashboard } from '../src/ui/dashboard.js';
import {
  type ResolvedTelescopeUiConfig,
  type TelescopeUiConfig,
  resolveConfig,
} from '../src/ui/define_config.js';
import { ExtensionApi } from '../src/ui/extension_api.js';
import { enforceGuard } from '../src/ui/guard.js';
import type { SseSink, UiHttpContext } from '../src/ui/http.js';

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
    );
    const apiBase = `${config.path}/api`;

    const router = await this.app.container.make('router');
    const guard = config.authorize;

    // Dashboard page (HTML).
    router
      .get(config.path, async (ctx: UiHttpContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        ctx.response.header('content-type', 'text/html; charset=utf-8');
        return ctx.response.send(renderDashboard(apiBase));
      })
      .as('telescope_ui.dashboard');

    // JSON API.
    router
      .get(`${apiBase}/entries`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.list(ctx);
      })
      .as('telescope_ui.entries');

    router
      .get(`${apiBase}/entries/:id`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.show(ctx, String(ctx.params.id));
      })
      .as('telescope_ui.entry');

    router
      .get(`${apiBase}/trace/:traceId`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.trace(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.trace');

    router
      .get(`${apiBase}/stats`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.stats(ctx);
      })
      .as('telescope_ui.stats');

    // Request replay (additive): re-issue a captured request from the dashboard.
    // A MUTATION, so it is a POST and is disabled by default (the handler answers
    // 403 unless telescope_ui `replay.enabled` is set) on top of the read guard.
    router
      .post(`${apiBase}/requests/:id/replay`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.replayRequest(ctx, String(ctx.params.id), localPortOf(ctx));
      })
      .as('telescope_ui.replay');

    // Metrics analytics (stats/timeseries/percentiles/traces/waterfall) + N+1.
    router
      .get(`${apiBase}/metrics/stats`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.metricsStats(ctx);
      })
      .as('telescope_ui.metrics_stats');

    router
      .get(`${apiBase}/metrics/timeseries`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.metricsTimeseries(ctx);
      })
      .as('telescope_ui.metrics_timeseries');

    router
      .get(`${apiBase}/metrics/traces`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.metricsTraces(ctx);
      })
      .as('telescope_ui.metrics_traces');

    router
      .get(`${apiBase}/metrics/waterfall/:traceId`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.metricsWaterfall(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_waterfall');

    router
      .get(`${apiBase}/metrics/n-plus-one/:traceId`, async (ctx: GuardedContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return api.metricsNPlusOne(ctx, String(ctx.params.traceId));
      })
      .as('telescope_ui.metrics_n_plus_one');

    // Pulse — aggregated health rollup. Registered only when enabled in core config.
    if (coreConfig.pulse.enabled) {
      router
        .get(`${apiBase}/metrics/pulse`, async (ctx: GuardedContext) => {
          if (!(await enforceGuard(ctx, guard))) return;
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
          if (!(await enforceGuard(ctx, guard))) return;
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
    if (registry) {
      const extCtx: ExtensionContext = {
        store,
        container: { make: (token) => this.app.container.make(token as never) },
        config: resolveTelescopeConfig(this.app.config.get('telescope', {})),
      };
      const extApi = new ExtensionApi(registry, extCtx);

      router
        .get(`${apiBase}/meta`, async (ctx: GuardedContext) => {
          if (!(await enforceGuard(ctx, guard))) return;
          return extApi.meta(ctx);
        })
        .as('telescope_ui.meta');

      router
        .get(`${apiBase}/ext/:ext/data/:provider`, async (ctx: GuardedContext) => {
          if (!(await enforceGuard(ctx, guard))) return;
          return extApi.data(ctx, String(ctx.params.ext), String(ctx.params.provider));
        })
        .as('telescope_ui.ext_data');
    }
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
