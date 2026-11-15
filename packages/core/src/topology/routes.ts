import type { HttpContext } from '@adonisjs/core/http';
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

/** A control plane's `POST <path>/ingest` and `GET <path>/whoami`. */
export function registerIngestRoutes(
  router: IngestRouter,
  handler: IngestHandler,
  limits: ResolvedIngestLimits,
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
}
