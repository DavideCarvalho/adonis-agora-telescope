import type { ApplicationService } from '@adonisjs/core/types';
import { resolveConfig as resolveTelescopeConfig } from '../src/define_config.js';
import {
  MISSING_MCP_AUTHORIZE_WARNING,
  type ResolvedTelescopeMcpConfig,
  resolveConfig,
  type TelescopeMcpConfig,
} from '../src/mcp/define_config.js';
import { scopedMcpServers } from '../src/mcp/scoped_servers.js';
import { getTelescopeRuntime } from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';
import { enforceGuard, enforceGuardDecision } from '../src/ui/guard.js';
import type { UiHttpContext } from '../src/ui/http.js';

/**
 * Wires `@adonis-agora/telescope/mcp` into the AdonisJS application.
 *
 * `boot()` reads `config/telescope_mcp.ts`, resolves the live telescope store from
 * the core runtime slot (no DI — the same handle the watchers record through), and
 * registers a JSON-RPC endpoint under the configured path via the AdonisJS router:
 *
 * - `POST <path>` — the MCP JSON-RPC surface (`initialize` / `tools/list` /
 *   `tools/call`). The route is a thin transport: it runs `authorize` (the same contract and
 *   guard as the console), then hands the parsed body to a plain, testable
 *   {@link TelescopeMcpServer}. A denial is JSON: `403 { error: 'forbidden' }` or
 *   `401 { error: 'unauthenticated' }`.
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
      { inProduction: this.app.inProduction === true },
    );
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

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;
    // Without `authorize` the endpoint is open outside production and denies every request in
    // production: say so once, at boot, in every environment.
    if (!config.authorizeConfigured) {
      await this.warn(MISSING_MCP_AUTHORIZE_WARNING);
    }

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
    // With tenancy on, each caller reads only the organizations its `authorize` granted.
    const serverFor = scopedMcpServers(store, coreConfig, config.tools);

    const router = await this.app.container.make('router');
    const guard = config.authorize;

    // JSON-RPC surface. The transport is thin: guard (a denial is written as JSON) → hand
    // `body` to the server. A `null` result is a notification (no id) → 202 with no body.
    router
      .post(config.path, async (ctx: McpContext) => {
        const decision = await enforceGuardDecision(ctx, guard);
        if (decision === null) return;
        const body = (ctx.request.body?.() ?? {}) as Record<string, unknown>;
        const result = await serverFor(decision).handle(body, true);
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
        if (!(await enforceGuard(ctx, guard))) return;
        ctx.response.status(405);
        return ctx.response.send({ error: 'MCP server is stateless; GET is not supported.' });
      })
      .as('telescope_mcp.get');

    // DELETE terminates a session; this stateless server holds none, so 200 (no-op).
    router
      .delete(config.path, async (ctx: McpContext) => {
        if (!(await enforceGuard(ctx, guard))) return;
        return ctx.response.status(200).send({ ok: true });
      })
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
