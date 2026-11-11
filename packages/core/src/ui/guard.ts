import {
  type AccessDeniedInfo,
  type AccessDeniedOption,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
import { normalizeConsoleDecision } from './console_authorize.js';
import type { AuthorizeHook, AuthorizeResult } from './define_config.js';
import type { UiHttpContext } from './http.js';

/** The outcome of an authorization check. */
export interface GuardResult {
  /** Whether the request may proceed to the handler. */
  allowed: boolean;
  /** When denied, the HTTP status the caller should answer with (401 or 403). */
  status?: number;
  /** When denied, the JSON error code: `'unauthenticated'` (`401`) or `'forbidden'` (`403`). */
  message?: 'unauthenticated' | 'forbidden';
  /** When the hook answered `{ redirectTo }`: where a page navigation is sent (`302`). */
  redirectTo?: string;
}

/**
 * Run the configured {@link AuthorizeHook} against a request and translate the
 * decision into a {@link GuardResult}. Framework-light: takes the same minimal
 * HTTP context the handlers do, so it is unit-testable without a server.
 *
 * The hook may return a bare `boolean` OR an {@link AuthorizeDecision} (`{ allowed, reason? }`).
 * The mapping is the dashboard-gate contract shared by every `@adonis-agora` console:
 * - `true` / `{ allowed: true }` → allowed.
 * - `reason: 'unauthenticated'` → `401`.
 * - `reason: 'forbidden'` → `403`.
 * - a bare `false`, or `{ allowed: false }` with no `reason` → `403` (fail closed).
 * - the hook throws → `403` (fail closed — never leaks the dashboard).
 * - `{ redirectTo }` → `401` carrying `redirectTo` (the page guard turns it into a `302`).
 */
export async function runGuard(ctx: UiHttpContext, authorize: AuthorizeHook): Promise<GuardResult> {
  let result: AuthorizeResult;
  try {
    result = await authorize(ctx);
  } catch {
    return { allowed: false, status: 403, message: 'forbidden' };
  }

  const decision = normalizeConsoleDecision(result);
  if (decision.allowed) return { allowed: true };
  if (decision.redirectTo !== undefined) {
    return {
      allowed: false,
      status: 401,
      message: 'unauthenticated',
      redirectTo: decision.redirectTo,
    };
  }
  if (decision.reason === 'unauthenticated') {
    return { allowed: false, status: 401, message: 'unauthenticated' };
  }
  return { allowed: false, status: 403, message: 'forbidden' };
}

/**
 * Guard `ctx` and, on denial, write the status + JSON error onto the response and return `false`:
 * `403 { error: 'forbidden' }`, `401 { error: 'unauthenticated' }`, or
 * `401 { error: 'unauthenticated', redirectTo }`. On success returns `true` and leaves the response
 * untouched for the handler. A `401` carries `WWW-Authenticate: Bearer`.
 *
 * Exception: if `authorize` itself already wrote a redirect (a `location` header — typically
 * `ctx.response.redirect(...)` to the host's own login/access-denied page) before returning `false`,
 * that redirect stands and this skips its own `401`/`403 { error }` write. Mirrors
 * `@adonis-agora/durable`'s dashboard guard, which honors the same signal the same way — a host that
 * wants a branded page instead of raw JSON redirects from inside `authorize` rather than needing a
 * separate hook.
 */
export async function enforceGuard(ctx: UiHttpContext, authorize: AuthorizeHook): Promise<boolean> {
  const result = await runGuard(ctx, authorize);
  if (result.allowed) return true;
  if (ctx.response.getHeader('location')) return false;
  const status = result.status ?? 403;
  ctx.response.status(status);
  if (status === 401) ctx.response.header('WWW-Authenticate', BEARER_CHALLENGE);
  if (result.redirectTo !== undefined) {
    ctx.response.send({ error: 'unauthenticated', redirectTo: result.redirectTo });
    return false;
  }
  ctx.response.send({ error: result.message ?? 'forbidden' });
  return false;
}

/** The `WWW-Authenticate` challenge a `401` carries (what `authorizeByToken` accepts). */
const BEARER_CHALLENGE = 'Bearer realm="Telescope"';

/** What {@link enforcePageGuard} needs to serve (or delegate) the access-denied page. */
export interface PageGuardOptions {
  /** The console's mount (`/telescope`) — reported to a custom renderer as `basePath`. */
  basePath: string;
  /** The host's `telescope_ui.accessDenied` option — tweak the built-in page, or render it. */
  accessDenied?: AccessDeniedOption<UiHttpContext> | null;
  /** The request's CSP nonce, applied to the page's inline `<style>`. */
  nonce?: string;
}

/**
 * {@link enforceGuard} for a PAGE navigation — the `@adonis-agora/telescope-ui` SPA shell and its
 * assets. Same decision ({@link runGuard}), same statuses, same "a redirect the hook wrote wins"
 * rule; what differs is the body: a browser gets the built-in access-denied page (or the host's
 * `accessDenied` customisation of it) instead of the `{ error }` JSON the API answers with.
 */
export async function enforcePageGuard(
  ctx: UiHttpContext,
  authorize: AuthorizeHook,
  options: PageGuardOptions,
): Promise<boolean> {
  const result = await runGuard(ctx, authorize);
  if (result.allowed) return true;
  const answered = () => responseAnswered(ctx);
  if (answered()) return false;
  if (result.redirectTo !== undefined) {
    ctx.response.status(302);
    ctx.response.header('location', result.redirectTo);
    ctx.response.send('');
    return false;
  }

  const status = result.status === 401 ? 401 : 403;
  const info: AccessDeniedInfo = {
    status,
    reason: status === 401 ? 'unauthenticated' : 'forbidden',
    basePath: options.basePath,
    ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
  };
  const html = await resolveAccessDeniedPage(info, options.accessDenied, ctx, answered);
  if (html === null) return false;

  ctx.response.status(status);
  ctx.response.header('content-type', 'text/html; charset=utf-8');
  ctx.response.header('cache-control', 'no-store, must-revalidate');
  ctx.response.send(html);
  return false;
}

/**
 * Whether something already answered this request: a redirect (`location` header — the signal the
 * `authorize` contract has always honoured) or a body already queued. The body check reads
 * AdonisJS's `response.hasLazyBody` (and {@link RecordingResponse}'s `sent`) structurally, so the
 * framework-light context stays framework-light.
 */
function responseAnswered(ctx: UiHttpContext): boolean {
  if (ctx.response.getHeader('location')) return true;
  const response = ctx.response as unknown as {
    hasLazyBody?: unknown;
    headersSent?: unknown;
    sent?: unknown;
  };
  return response.hasLazyBody === true || response.headersSent === true || response.sent === true;
}
