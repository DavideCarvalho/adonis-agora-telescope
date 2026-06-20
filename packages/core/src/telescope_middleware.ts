import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { recordExceptionInStore } from './exception_watcher.js';
import { getTelescopeRuntime } from './registry.js';
import { type HttpContextLike, recordRequest } from './request_watcher.js';

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
    if (!runtime.store || !runtime.requestWatcherEnabled) {
      return next();
    }

    const startedAt = Date.now();
    const store = runtime.store;
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
        await recordRequest(store, ctx as unknown as HttpContextLike, startedAt);
      } catch {
        // Observability must never break the request it observes.
      }
    }
  }
}
