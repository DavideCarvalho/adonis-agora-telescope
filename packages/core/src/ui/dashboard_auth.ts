import type { HttpContext } from '@adonisjs/core/http';
import { type ResolvedDashboardAuth, SESSION_COOKIE_NAME, decideDashboardAuth } from './auth.js';

/**
 * The AdonisJS glue for the built-in `dashboardAuth` session — the ONLY place that touches an
 * `HttpContext`, so the decision logic in `auth.ts`/`session_cookie.ts` stays framework-light and
 * unit-testable. Reads and writes the signed session via AdonisJS's NATIVE `plainCookie` API (the
 * value carries its own HMAC signature, so `encode: false` skips Adonis's redundant cookie signing).
 *
 * The provider composes {@link enforceDashboardAuth} AFTER its existing `authorize` guard: both must
 * pass. When `dashboardAuth` is unconfigured the provider simply never calls this, so behavior is
 * byte-for-byte unchanged.
 */

/** Read the raw (unencoded) session cookie value, or `undefined` when absent/blank. */
export function readSessionCookie(ctx: HttpContext): string | undefined {
  const value = ctx.request.plainCookie(SESSION_COOKIE_NAME, undefined, false);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Write the signed session as an unsigned (`plainCookie`, `encode: false`) cookie — the value
 * carries its own HMAC signature, so AdonisJS's cookie signing would be redundant double-wrapping.
 * `HttpOnly` + `SameSite=Lax` (blocks cross-site POSTs carrying the cookie — CSRF coverage) +
 * `Secure` on https. `Path=/` so it reaches both the SPA and the API mounts regardless of prefix.
 */
export function writeSessionCookie(
  ctx: HttpContext,
  auth: ResolvedDashboardAuth,
  value: string,
): void {
  ctx.response.plainCookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.request.secure(),
    path: '/',
    maxAge: Math.floor(auth.ttlMs / 1000),
    encode: false,
  });
}

/** Clear the session cookie (logout). `Path=/` mirrors {@link writeSessionCookie}. */
export function clearSessionCookie(ctx: HttpContext): void {
  ctx.response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * The session half of the composed dashboard guard, run AFTER the `authorize` hook has passed.
 * Reads the session cookie, and on no valid session either redirects a `page` navigation `302` to
 * the login page (carrying a `returnTo`) or answers an `api` request with a plain `401`. Returns
 * `true` to allow the request through (valid session), `false` when it has already written the
 * response and the route must short-circuit.
 *
 * Callers only invoke this when `dashboardAuth` is configured, so `auth` is always non-null here.
 */
export async function enforceDashboardAuth(
  ctx: HttpContext,
  auth: ResolvedDashboardAuth,
  mode: 'page' | 'api',
  basePath: string,
): Promise<boolean> {
  const decision = decideDashboardAuth(auth, readSessionCookie(ctx), mode, ctx.request.url(true));
  if (decision.kind === 'allow') return true;
  if (decision.kind === 'redirect') {
    ctx.response.redirect().withQs('returnTo', decision.returnTo).toPath(`${basePath}/login`);
    return false;
  }
  ctx.response.status(401).json({ error: 'unauthorized' });
  return false;
}
