import { summarizeChecks } from '../fleet/checks.js';
import { type FleetScope, readFleet } from '../fleet/view.js';
import { getTelescopeRuntime } from '../registry.js';
import type { TelescopeStore } from '../store.js';
import { appOfTag } from './app_scope.js';
import type { UiHttpContext } from './http.js';

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
          ...report,
        },
      });
  }
}
