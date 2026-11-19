import { controlPlaneHosts } from '../architecture/hosts.js';
import { readArchitecture } from '../architecture/view.js';
import { summarizeChecks } from '../fleet/checks.js';
import { type FleetScope, readFleet } from '../fleet/view.js';
import { getTelescopeRuntime } from '../registry.js';
import type { TelescopeStore } from '../store.js';
import { appOfTag } from './app_scope.js';
import type { UiHttpContext } from './http.js';

/** The windows the Architecture page reads calls over. */
const ARCHITECTURE_WINDOWS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/** The app ids of an app-scope selection (`null` tags: every app). */
export function appsOfTags(tags: string[] | null): string[] | null {
  if (tags === null) return null;
  return tags.map(appOfTag).filter((id): id is string => id !== undefined);
}

/**
 * `GET <path>/api/fleet` and `GET <path>/api/health`: the fleet (instances per app, deploys,
 * restart loops, failing checks with the exceptions since) and this process's checks. Reads the
 * fleet the core provider published; `source` is the viewer's slice of the store, for the
 * related exceptions.
 */
export class FleetApi {
  constructor(
    private readonly source: TelescopeStore,
    private readonly tagByApp: boolean,
  ) {}

  /** The fleet as `scope` sees it. */
  async read(scope: FleetScope) {
    const runtime = getTelescopeRuntime();
    return readFleet(scope, {
      fleet: runtime.fleet,
      reporter: runtime.reporter,
      selfChecks: () => runtime.healthChecks?.states() ?? [],
      store: this.source,
      tagByApp: this.tagByApp,
    });
  }

  async fleet(ctx: UiHttpContext, scope: FleetScope): Promise<unknown> {
    return ctx.response
      .status(200)
      .header('cache-control', 'private, no-store')
      .send({ data: await this.read(scope) });
  }

  /**
   * `GET <path>/api/architecture`: the apps and what links them (calls in the last `window`,
   * grants and catalogs from authkit when it runs here). Shared infrastructure, like the fleet:
   * hidden from a viewer limited to some organizations.
   */
  async architecture(ctx: UiHttpContext, scope: FleetScope): Promise<unknown> {
    if (scope.hidden === true) {
      return ctx.response.status(403).send({
        error: 'The architecture is shared by every organization: it needs access to all of them.',
      });
    }
    const raw = ctx.request.qs().window;
    const windowMs = ARCHITECTURE_WINDOWS[typeof raw === 'string' ? raw : '1h'];
    if (windowMs === undefined) {
      return ctx.response.status(400).send({ error: '`window` must be 1h, 6h or 24h.' });
    }
    const fleet = await this.read({ apps: scope.apps });
    const view = await readArchitecture({
      store: this.source,
      fleet,
      windowMs,
      apps: scope.apps,
      selfApp: getTelescopeRuntime().selfApp,
      selfHosts: controlPlaneHosts(),
    });
    return ctx.response
      .status(200)
      .header('cache-control', 'private, no-store')
      .send({ data: view });
  }

  /** This process's checks, run now (each reused for its `cacheFor`). */
  async health(ctx: UiHttpContext, hidden: boolean): Promise<unknown> {
    if (hidden) {
      return ctx.response.status(403).send({
        error: 'Health checks are shared by every organization: they need access to all of them.',
      });
    }
    const runtime = getTelescopeRuntime();
    const checks = runtime.healthChecks;
    const report = checks !== null ? await checks.report() : summarizeChecks([]);
    return ctx.response
      .status(200)
      .header('cache-control', 'private, no-store')
      .send({
        data: {
          configured: checks !== null,
          state: runtime.reporter?.currentState ?? null,
          instanceId: runtime.reporter?.instanceId ?? null,
          role: runtime.reporter?.role ?? null,
          ...report,
        },
      });
  }
}
