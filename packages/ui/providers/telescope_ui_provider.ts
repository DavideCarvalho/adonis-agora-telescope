import type { ApplicationService } from '@adonisjs/core/types';
import { TelescopeService, type TelescopeStore, getTelescopeRuntime } from '@agora/telescope';
import { TelescopeApi } from '../src/api.js';
import { renderDashboard } from '../src/dashboard.js';
import {
  type ResolvedTelescopeUiConfig,
  type TelescopeUiConfig,
  resolveConfig,
} from '../src/define_config.js';
import { enforceGuard } from '../src/guard.js';
import type { UiHttpContext } from '../src/http.js';

/**
 * Wires `@agora/telescope-ui` into the AdonisJS application.
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
        'TelescopeUiProvider: telescope store is not booted (is @agora/telescope enabled?); ' +
          'dashboard routes not registered.',
      );
      return;
    }

    const service = new TelescopeService(store);
    const api = new TelescopeApi(service);
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
  }
}

/** The AdonisJS `HttpContext` slice the route handlers touch (structural). */
interface GuardedContext extends UiHttpContext {
  params: Record<string, unknown>;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
