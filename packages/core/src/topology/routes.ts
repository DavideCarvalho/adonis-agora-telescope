import type { HttpContext } from '@adonisjs/core/http';
import type { DiscoveryPublisher } from '../discovery/server.js';
import type { ResolvedIngestLimits } from './config.js';
import type { IngestHandler, IngestResponse } from './ingest.js';
import { APP_HEADER } from './wire.js';

/** The bearer token of a request. */
function bearer(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (typeof header !== 'string') return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function send(ctx: HttpContext, response: IngestResponse) {
  ctx.response.header('cache-control', 'no-store');
  return ctx.response.status(response.status).json(response.body);
}

/** The slice of the AdonisJS router the ingest routes need. */
export interface IngestRouter {
  post(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
}

/** Longest a `GET <path>/discovery` is held open. */
const MAX_DISCOVERY_WAIT_S = 30;

/**
 * A control plane's `POST <path>/ingest`, `GET <path>/whoami`, and (with a fleet)
 * `GET <path>/discovery?since=<version>&wait=<seconds>`: the discovery map the caller's token may
 * see, answered at once when `since` is not the current version, else held until it changes.
 */
export function registerIngestRoutes(
  router: IngestRouter,
  handler: IngestHandler,
  limits: ResolvedIngestLimits,
  discovery: DiscoveryPublisher | null = null,
): void {
  router
    .post(`${limits.path}/ingest`, async (ctx: HttpContext) => {
      const length = Number(ctx.request.header('content-length'));
      return send(
        ctx,
        await handler.ingest({
          token: bearer(ctx),
          app: ctx.request.header(APP_HEADER) ?? undefined,
          contentLength: Number.isFinite(length) ? length : undefined,
          body: ctx.request.body(),
        }),
      );
    })
    .as('telescope.ingest');
  router
    .get(`${limits.path}/whoami`, async (ctx: HttpContext) =>
      send(
        ctx,
        await handler.whoami({
          token: bearer(ctx),
          app: ctx.request.header(APP_HEADER) ?? undefined,
        }),
      ),
    )
    .as('telescope.whoami');
  if (discovery !== null) {
    router
      .get(`${limits.path}/discovery`, async (ctx: HttpContext) => {
        const caller = await handler.caller({
          token: bearer(ctx),
          app: ctx.request.header(APP_HEADER) ?? undefined,
        });
        if ('status' in caller) return send(ctx, caller);
        const qs = ctx.request.qs() as Record<string, unknown>;
        const since = typeof qs.since === 'string' && qs.since !== '' ? qs.since : null;
        const wait = Math.min(MAX_DISCOVERY_WAIT_S, Math.max(0, Number(qs.wait) || 0));
        const map = await discovery.wait(caller.environment ?? null, since, wait * 1000);
        return send(ctx, { status: 200, body: { ...map } });
      })
      .as('telescope.discovery');
  }
}
