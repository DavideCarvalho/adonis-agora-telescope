import type { HealthChecks } from './checks.js';
import type { InstanceState } from './heartbeat.js';

/** What a probe route answers. */
export interface ProbeResponse {
  status: number;
  body: {
    status: 'ok' | 'warn' | 'down' | 'draining';
    checks?: Array<{ name: string; status: string }>;
  };
}

/**
 * The readiness probe: 503 while a critical check is down or the instance is draining, 200
 * otherwise (a `warn` stays in rotation). Messages are left out: the route is unauthenticated.
 */
export async function readiness(
  checks: HealthChecks | null,
  state: InstanceState | null,
): Promise<ProbeResponse> {
  const report = checks !== null ? await checks.report() : { status: 'ok' as const, checks: [] };
  const list = report.checks.map((c) => ({ name: c.name, status: c.status }));
  if (state === 'draining') return { status: 503, body: { status: 'draining', checks: list } };
  return {
    status: report.status === 'down' ? 503 : 200,
    body: { status: report.status, checks: list },
  };
}

/** The liveness probe: 200 while the process answers. It never runs the checks. */
export function liveness(state: InstanceState | null): ProbeResponse {
  return { status: 200, body: { status: state === 'draining' ? 'draining' : 'ok' } };
}

/** The slice of the AdonisJS router the probe routes need. */
export interface ProbeRouter {
  get(
    pattern: string,
    handler: (ctx: {
      response: {
        status(code: number): { json(body: unknown): unknown };
        header(name: string, value: string): unknown;
      };
    }) => unknown,
  ): { as(name: string): unknown };
}

/** Register `health.readiness` / `health.liveness` (unauthenticated). */
export function registerProbeRoutes(
  router: ProbeRouter,
  paths: { readiness: string | null; liveness: string | null },
  read: () => { checks: HealthChecks | null; state: InstanceState | null },
): void {
  if (paths.readiness !== null) {
    router
      .get(paths.readiness, async (ctx) => {
        const { checks, state } = read();
        const answer = await readiness(checks, state);
        ctx.response.header('cache-control', 'no-store');
        return ctx.response.status(answer.status).json(answer.body);
      })
      .as('telescope.health.readiness');
  }
  if (paths.liveness !== null) {
    router
      .get(paths.liveness, (ctx) => {
        const answer = liveness(read().state);
        ctx.response.header('cache-control', 'no-store');
        return ctx.response.status(answer.status).json(answer.body);
      })
      .as('telescope.health.liveness');
  }
}
