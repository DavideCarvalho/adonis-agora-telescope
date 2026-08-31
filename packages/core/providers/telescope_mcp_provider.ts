import type { ApplicationService } from '@adonisjs/core/types';
import type { ExceptionEntryContent } from '../src/ai/diagnoser.js';
import { resolveConfig as resolveTelescopeConfig } from '../src/define_config.js';
import type { Entry } from '../src/entry.js';
import {
  type ResolvedTelescopeMcpConfig,
  resolveConfig,
  type TelescopeMcpConfig,
} from '../src/mcp/define_config.js';
import { VERSION } from '../src/mcp/index.js';
import type { DiagnoseExceptionHook } from '../src/mcp/server.js';
import { TelescopeMcpServer } from '../src/mcp/server.js';
import { MetricsService } from '../src/metrics/metrics_service.js';
import { getTelescopeRuntime } from '../src/registry.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { runGuard } from '../src/ui/guard.js';
import type { UiHttpContext } from '../src/ui/http.js';

/**
 * Wires `@adonis-agora/telescope/mcp` into the AdonisJS application.
 *
 * `boot()` reads `config/telescope_mcp.ts`, resolves the live telescope store from
 * the core runtime slot (no DI — the same handle the watchers record through), and
 * registers a JSON-RPC endpoint under the configured path via the AdonisJS router:
 *
 * - `POST <path>` — the MCP JSON-RPC surface (`initialize` / `tools/list` /
 *   `tools/call`). The route is a thin transport: it runs the SAME auth guard as the
 *   dashboard, then hands the parsed body + the `allowed` flag to a plain, testable
 *   {@link TelescopeMcpServer}. A denial rides inside the JSON-RPC envelope (`-32001`)
 *   because MCP has no transport-level 401.
 * - `GET <path>` — 405: this stateless server has no server→client stream.
 * - `DELETE <path>` — 200 no-op: it holds no session to terminate.
 *
 * Failures degrade safely: a disabled config or a missing store registers no routes
 * (warn-logged), so the endpoint simply does not exist rather than crashing the host.
 */
export default class TelescopeMcpProvider {
  constructor(protected app: ApplicationService) {}

  private resolve(): ResolvedTelescopeMcpConfig {
    return resolveConfig(
      this.app.config.get<TelescopeMcpConfig | undefined>('telescope_mcp', undefined),
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
        `TelescopeMcpProvider: could not resolve the telescope store: ${asMessage(err)}`,
      );
      return;
    }
    if (store === null) {
      console.warn(
        'TelescopeMcpProvider: telescope store is not booted (is @adonis-agora/telescope enabled?); ' +
          'MCP endpoint not registered.',
      );
      return;
    }

    const coreConfig = resolveTelescopeConfig(this.app.config.get('telescope', {}));
    const service = new TelescopeService(store, {
      windowMs: coreConfig.pulse.windowMs,
      topN: coreConfig.pulse.topN,
      buckets: coreConfig.pulse.buckets,
      slowRouteMs: coreConfig.pulse.slowRouteMs,
      cards: coreConfig.pulse.cards,
      ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
    });
    const metrics = new MetricsService(store, {
      ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
    });
    // Wire the AI diagnosis hook when a configured coordinator is published in the
    // runtime slot. When AI is off (no coordinator, or an inert one), NO hook is
    // passed, so `diagnose_exception` reports "not configured" exactly as before.
    const coordinator = getTelescopeRuntime().diagnosisCoordinator;
    const diagnose: DiagnoseExceptionHook | undefined = coordinator?.isConfigured()
      ? async (entry: Entry) => {
          // Feed the same-trace siblings as extra context (already redacted).
          const related = entry.traceId !== null ? await service.byTrace(entry.traceId) : undefined;
          return coordinator.diagnoseMarkdown(entry as Entry<ExceptionEntryContent>, {
            ...(related !== undefined ? { related } : {}),
          });
        }
      : undefined;

    const server = new TelescopeMcpServer(service, metrics, {
      tools: config.tools,
      // Reported to the MCP client on `initialize`. Sourced from the package's own
      // VERSION const (kept in lockstep with package.json by `scripts/sync-version.mjs`)
      // so a release bump can never leave a stale version on the wire.
      serverInfo: { name: 'adonis-telescope', version: VERSION },
      ...(diagnose !== undefined ? { diagnose } : {}),
    });

    const router = await this.app.container.make('router');
    const guard = config.authorize;

    // JSON-RPC surface. The transport is thin: guard → hand `body` + `allowed` to the
    // server. A `null` result is a notification (no id) → 202 with no body.
    router
      .post(config.path, async (ctx: McpContext) => {
        const { allowed } = await runGuard(ctx, guard);
        const body = (ctx.request.body?.() ?? {}) as Record<string, unknown>;
        const result = await server.handle(body, allowed);
        if (result === null) {
          ctx.response.status(202);
          return ctx.response.send('');
        }
        return ctx.response.status(200).send(result);
      })
      .as('telescope_mcp.rpc');

    // The MCP streamable-HTTP transport opens a GET stream for server→client
    // notifications; this stateless server has none, so 405 (per the spec).
    router
      .get(config.path, async (ctx: McpContext) => {
        ctx.response.status(405);
        return ctx.response.send({ error: 'MCP server is stateless; GET is not supported.' });
      })
      .as('telescope_mcp.get');

    // DELETE terminates a session; this stateless server holds none, so 200 (no-op).
    router
      .delete(config.path, async (ctx: McpContext) => ctx.response.status(200).send({ ok: true }))
      .as('telescope_mcp.delete');
  }
}

/**
 * The AdonisJS `HttpContext` slice the MCP route touches: the guard's request/response
 * surface plus `request.body()` (the parsed JSON-RPC payload).
 */
interface McpContext extends UiHttpContext {
  request: UiHttpContext['request'] & { body?: () => unknown };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
