import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { recordExceptionInStore } from './exception_watcher.js';
import type { ProfileHandle } from './profiling/profiler_service.js';
import { getTelescopeRuntime } from './registry.js';
import { type HttpContextLike, recordRequest } from './request_watcher.js';

/** The bit of AdonisJS's real `HttpContext` a route-labelled profile needs beyond
 *  {@link HttpContextLike} — the matched route's pattern (e.g. `/users/:id`), when the router has
 *  resolved one at this point in the pipeline. Structural, so it degrades to the raw URL when absent
 *  (e.g. a 404, or a context built without the router). */
interface RouteMatchedContext {
  route?: { pattern?: string } | null;
}

/** `"GET /users/:id"` when the router matched a route, else `"GET <raw url>"`. Mirrors the NestJS
 *  sibling's `normalizeRoute` label closely enough for `ProfilerService`'s manual-arm `label` match
 *  and the `cpu_profile` entry's `familyHash` to be genuinely useful for grouping repeated captures
 *  of the same endpoint — without adding a whole route-normalization module for one label. */
function profileLabel(ctx: HttpContextLike): string {
  const method = ctx.request.method();
  const pattern = (ctx as unknown as RouteMatchedContext).route?.pattern;
  return `${method} ${pattern ?? ctx.request.url()}`;
}

/**
 * Records each inbound HTTP request as a `request` telescope entry (method, url,
 * status, duration, traceId), and auto-captures any exception thrown by the
 * downstream pipeline as an `exception` entry (message, name, stack, a stable
 * family hash, traceId, method/url) BEFORE re-throwing — so HTTP exceptions are
 * captured with zero app changes. Registered on the **server** middleware stack
 * so it wraps the whole pipeline and observes the final response status.
 *
 * Reads the active store from the global runtime slot rather than via DI, so the
 * middleware needs no constructor wiring and is a no-op (zero overhead) when
 * telescope is disabled or not booted. Both recordings are wrapped so they can
 * never break a request and never swallow the original error.
 */
export default class TelescopeMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const runtime = getTelescopeRuntime();
    // `runtime.paused` is the overload guard's shed flag: while set, skip recording
    // entirely (request + auto-captured exception) so telescope can't amplify load.
    if (!runtime.store || !runtime.requestWatcherEnabled || runtime.paused) {
      return next();
    }

    const startedAt = Date.now();
    const store = runtime.store;

    // Opt-in CPU profiling (`@adonis-agora/telescope/cpu_profiling`): a single cheap boolean gate
    // when the feature isn't installed/enabled (`runtime.cpuProfiler` is `null`, or its
    // `shouldProfile` returns `false`). When a request IS selected, `begin` starts a real
    // `node:inspector` capture now and `end` stops+records it in the `finally` below, so the
    // captured `cpu_profile` entry shares this request's trace context.
    const httpCtx = ctx as unknown as HttpContextLike;
    const label = runtime.cpuProfiler ? profileLabel(httpCtx) : null;
    const profile: ProfileHandle | null =
      label !== null && runtime.cpuProfiler?.shouldProfile(label)
        ? runtime.cpuProfiler.begin(label)
        : null;

    try {
      return await next();
    } catch (error: unknown) {
      // Auto-capture the exception, then re-throw the ORIGINAL error untouched.
      // Recording is wrapped so it can never mask the error it observes.
      try {
        const request = (ctx as unknown as HttpContextLike).request;
        await recordExceptionInStore(store, error, {
          method: request.method(),
          url: request.url(),
        });
      } catch {
        // Observability must never break the request it observes.
      }
      throw error;
    } finally {
      // Post-response phase: record the now-complete request. Awaited so a slow
      // store surfaces back-pressure here rather than leaking an unhandled
      // rejection, but wrapped so observability can never break the request.
      try {
        await recordRequest(store, ctx as unknown as HttpContextLike, startedAt, {
          // Body capture is opt-in: only pass `capture` when configured, so the
          // default stays "no body field" and zero body-read overhead.
          ...(runtime.requestCapture !== null ? { capture: runtime.requestCapture } : {}),
          // Host enrichment (screen tag, tenant, …). Absent unless configured.
          ...(runtime.requestEnrichment !== null ? { enrich: runtime.requestEnrichment } : {}),
        });
      } catch {
        // Observability must never break the request it observes.
      }
      // Stop + record the profile (if one was armed/sampled) within the same
      // `finally` so its `cpu_profile` entry shares this request's trace context.
      // Fire-and-forget: `end` never throws and never blocks the response.
      if (profile !== null) {
        void runtime.cpuProfiler?.end(profile, label);
      }
    }
  }
}
