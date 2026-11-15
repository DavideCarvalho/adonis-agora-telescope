import { timingSafeEqual } from 'node:crypto';
import { getTelescopeRuntime } from '../../registry.js';
import { fleetCheckStates } from './fleet_source.js';

/**
 * The "current check states" contract the uptime integrations (heartbeats,
 * status pages and the pull health endpoint) read. It is the shape Telescope's
 * health checks report (`ok` / `warn` / `down` / `unknown`), plus an optional
 * `app` so a control plane can report every app's checks.
 */

/** A check's status as reported: `warn` is degraded but serving; `unknown` = not run yet. */
export type UptimeCheckStatus = 'ok' | 'warn' | 'down' | 'unknown';

/** One check's current state. */
export interface UptimeCheckState {
  /** Check name, e.g. `redis`, `postgres`, `disk`. */
  name: string;
  status: UptimeCheckStatus;
  /** The app the check belongs to (control plane: one set of checks per app). */
  app?: string;
  /** Short human detail, e.g. `"PING timed out after 2s"`. */
  message?: string | null;
  /** When the check entered its current status (epoch ms or ISO-8601). */
  since?: number | string;
  /**
   * `false` for a check that is shown but must not mark the app unhealthy (it
   * still moves status page components). Default `true`.
   */
  critical?: boolean;
}

/** Returns the current check states. May be sync or async; must be cheap (cached). */
export type CheckStateSource = () => UptimeCheckState[] | Promise<UptimeCheckState[]>;

/** What the integrations report: `up`, `degraded` or `down`. */
export type HealthStatus = 'up' | 'degraded' | 'down';

const RANK: Record<HealthStatus, number> = { up: 0, degraded: 1, down: 2 };

/** A state's health, or `null` for `unknown` (not run yet: ignored). */
export function healthOf(state: UptimeCheckState): HealthStatus | null {
  switch (state.status) {
    case 'ok':
      return 'up';
    case 'warn':
      return 'degraded';
    case 'down':
      return 'down';
    default:
      return null;
  }
}

/** The worst health among `states` (unknown ones ignored); `up` when there are none. */
export function worstStatus(states: readonly UptimeCheckState[]): HealthStatus {
  let worst: HealthStatus = 'up';
  for (const state of states) {
    const health = healthOf(state);
    if (health !== null && RANK[health] > RANK[worst]) worst = health;
  }
  return worst;
}

/** The worst of two health statuses. */
export function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** The states that belong to `app` (all of them when `app` is `null`). */
export function statesFor(
  states: readonly UptimeCheckState[],
  app: string | null,
): UptimeCheckState[] {
  return app === null ? [...states] : states.filter((state) => state.app === app);
}

/** The states that decide whether the app is healthy (`critical: false` ones don't). */
export function criticalStates(states: readonly UptimeCheckState[]): UptimeCheckState[] {
  return states.filter((state) => state.critical !== false);
}

/** One line naming every check that isn't up, e.g. `redis down: OOM; disk degraded`. */
export function describeProblems(states: readonly UptimeCheckState[]): string {
  return states
    .filter((state) => state.status === 'warn' || state.status === 'down')
    .map((state) => {
      const who = state.app !== undefined ? `${state.app}/${state.name}` : state.name;
      const message =
        state.message !== undefined && state.message !== null && state.message !== ''
          ? `: ${state.message}`
          : '';
      return `${who} ${healthOf(state)}${message}`;
    })
    .join('; ');
}

/** Read the source, never throwing. `null` means "health unknown". */
export async function readStates(
  source: CheckStateSource,
  logger: (message: string) => void,
): Promise<UptimeCheckState[] | null> {
  try {
    const states = await source();
    return Array.isArray(states) ? states : null;
  } catch (error: unknown) {
    logger(
      `Telescope health source failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pull: a health endpoint for UptimeRobot / Better Stack / Uptime Kuma
// ---------------------------------------------------------------------------

export interface UptimeEndpointOptions {
  /** Where the check states come from. Default: the {@link publishCheckStates published} source. */
  source?: CheckStateSource;
  /**
   * Shared secret. When set, a request must carry it as `?token=` (see
   * `tokenQuery`) or in the `x-telescope-health-token` header (see `tokenHeader`).
   * Without it the endpoint answers `401`.
   */
  token?: string;
  /** Query-string parameter that may carry the token. Default `'token'`. */
  tokenQuery?: string;
  /** Header that may carry the token. Default `'x-telescope-health-token'`. */
  tokenHeader?: string;
  /** Status code for `degraded`. Default `200` (the app still serves). */
  degradedStatusCode?: number;
  /**
   * Include each check in the body. Default: `true` when a `token` is set,
   * `false` otherwise (an open endpoint only says up/degraded/down).
   */
  details?: boolean;
}

/** The body the endpoint returns. Keyword monitors can match `"status":"up"`. */
export interface UptimeBody {
  status: HealthStatus;
  app?: string;
  checks?: Array<{
    name: string;
    status: UptimeCheckStatus;
    app?: string;
    message?: string;
    critical?: boolean;
  }>;
  checkedAt: string;
}

/**
 * Pure: the status code and body for a set of states. `up` → 200, `degraded` →
 * `degradedStatusCode` (200), `down` → 503. Scoped to an `app` that has no
 * states, the answer is `down`.
 */
export function uptimeResponse(
  states: readonly UptimeCheckState[],
  options: { degradedStatusCode?: number; details?: boolean; app?: string | null; now?: Date } = {},
): { statusCode: number; body: UptimeBody } {
  const scoped = statesFor(states, options.app ?? null);
  // An app with no states at all is not reporting: treat it as down.
  const unknownApp = options.app !== undefined && options.app !== null && scoped.length === 0;
  const status: HealthStatus = unknownApp ? 'down' : worstStatus(criticalStates(scoped));
  const statusCode =
    status === 'up' ? 200 : status === 'degraded' ? (options.degradedStatusCode ?? 200) : 503;
  const body: UptimeBody = {
    status,
    ...(options.app !== undefined && options.app !== null ? { app: options.app } : {}),
    ...(options.details === true
      ? {
          checks: scoped.map((state) => ({
            name: state.name,
            status: state.status,
            ...(state.app !== undefined ? { app: state.app } : {}),
            ...(typeof state.message === 'string' ? { message: state.message } : {}),
            ...(state.critical === false ? { critical: false } : {}),
          })),
        }
      : {}),
    checkedAt: (options.now ?? new Date()).toISOString(),
  };
  return { statusCode, body };
}

/** The slice of an AdonisJS `HttpContext` the handler uses. */
export interface UptimeHttpContext {
  request: { qs(): Record<string, unknown>; header(name: string): string | null | undefined };
  response: {
    status(code: number): unknown;
    json(body: unknown): unknown;
    header?(name: string, value: string): unknown;
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * A route handler for external uptime monitors:
 *
 * ```ts
 * router.get('/uptime', uptimeEndpoint({ source, token: env.get('UPTIME_TOKEN') }))
 * ```
 *
 * `?app=<name>` scopes the answer to one app (control plane). When the source
 * fails, the endpoint answers 503 — a monitor should treat "can't tell" as down.
 */
export function uptimeEndpoint(options: UptimeEndpointOptions) {
  const queryName = options.tokenQuery ?? 'token';
  const headerName = options.tokenHeader ?? 'x-telescope-health-token';
  const details = options.details ?? options.token !== undefined;
  return async (ctx: UptimeHttpContext): Promise<unknown> => {
    ctx.response.header?.('cache-control', 'no-store');
    const qs = ctx.request.qs();
    if (options.token !== undefined) {
      const fromQuery = qs[queryName];
      const presented =
        (typeof fromQuery === 'string' ? fromQuery : undefined) ??
        ctx.request.header(headerName) ??
        '';
      if (!safeEqual(presented, options.token)) {
        ctx.response.status(401);
        return ctx.response.json({ status: 'unauthorized' });
      }
    }
    const app = typeof qs.app === 'string' && qs.app !== '' ? qs.app : null;
    const source = options.source ?? publishedCheckStates();
    const states = source === null ? null : await readStates(source, () => {});
    if (states === null) {
      ctx.response.status(503);
      return ctx.response.json({ status: 'down', checkedAt: new Date().toISOString() });
    }
    const { statusCode, body } = uptimeResponse(states, {
      details,
      app,
      ...(options.degradedStatusCode !== undefined
        ? { degradedStatusCode: options.degradedStatusCode }
        : {}),
    });
    ctx.response.status(statusCode);
    return ctx.response.json(body);
  };
}

// ---------------------------------------------------------------------------
// The plug point: whoever owns the checks publishes a source here
// ---------------------------------------------------------------------------

const SOURCE_KEY = Symbol.for('@agora/telescope:check-states');
const slot = globalThis as typeof globalThis & { [SOURCE_KEY]?: CheckStateSource | null };

/**
 * Publish the process-wide check-state source. Telescope's health checks (or the
 * host) call this once at boot; heartbeats, status pages and the uptime endpoint
 * read it when their config doesn't name a `checkStates` source. Pass `null` to
 * unpublish.
 */
export function publishCheckStates(source: CheckStateSource | null): void {
  slot[SOURCE_KEY] = source;
}

/**
 * The check-state source the uptime integrations use by default: the published
 * one; else the fleet (every app's checks, on a control plane or a standalone
 * app); else this process's health checks; else `null`.
 */
export function publishedCheckStates(): CheckStateSource | null {
  const published = slot[SOURCE_KEY];
  if (published !== undefined && published !== null) return published;
  const runtime = getTelescopeRuntime();
  const fleet = runtime.fleet;
  if (fleet !== null && fleet !== undefined) return () => fleetCheckStates(fleet);
  const checks = runtime.healthChecks;
  if (checks !== null && checks !== undefined) return () => checks.states();
  return null;
}
