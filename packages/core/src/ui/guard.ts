import {
  type AccessDeniedInfo,
  type AccessDeniedOption,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
import type { AuthorizeHook } from './define_config.js';
import type { UiHttpContext } from './http.js';

/** The outcome of an authorization check. */
export interface GuardResult {
  /** Whether the request may proceed to the handler. */
  allowed: boolean;
  /** When denied, the HTTP status the caller should answer with (401 or 403). */
  status?: number;
  /** When denied, a short message body. */
  message?: string;
}

/**
 * Run the configured {@link AuthorizeHook} against a request and translate the
 * decision into a {@link GuardResult}. Framework-light: takes the same minimal
 * HTTP context the handlers do, so it is unit-testable without a server.
 *
 * Denials are distinguished:
 * - **401** when the request presented NO credential at all (an `Authorization`
 *   header is absent and no `?token`) — prompts the host/browser to authenticate;
 * - **403** when a credential WAS presented but rejected (wrong token/password).
 *
 * Any error thrown by a custom `authorize` hook fails closed (403) rather than
 * leaking the dashboard.
 */
export async function runGuard(ctx: UiHttpContext, authorize: AuthorizeHook): Promise<GuardResult> {
  let allowed: boolean;
  try {
    allowed = await authorize(ctx);
  } catch {
    return { allowed: false, status: 403, message: 'Forbidden' };
  }
  if (allowed) return { allowed: true };

  const presentedCredential =
    ctx.request.header('authorization') !== undefined || typeof ctx.request.qs().token === 'string';

  return presentedCredential
    ? { allowed: false, status: 403, message: 'Forbidden' }
    : { allowed: false, status: 401, message: 'Unauthorized' };
}

/**
 * Guard `ctx` and, on denial, write the status + message onto the response and
 * return `false`. On success returns `true` and leaves the response untouched for
 * the handler. A `WWW-Authenticate` header is sent on a 401 so a browser can
 * surface a Basic-auth prompt when that scheme is in play.
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
  if (status === 401) {
    ctx.response.header('WWW-Authenticate', 'Basic realm="Telescope", Bearer');
  }
  ctx.response.send({ error: result.message ?? 'Forbidden' });
  return false;
}

/** What {@link enforcePageGuard} needs to serve (or delegate) the access-denied page. */
export interface PageGuardOptions {
  /** The console's mount (`/telescope`) — reported to a custom renderer as `basePath`. */
  basePath: string;
  /** The built-in login page (`<path>/login`), present only when `dashboardAuth` is configured. */
  loginHref?: string;
  /** The host's `telescope_ui.accessDenied` option — tweak the built-in page, or render it. */
  accessDenied?: AccessDeniedOption<UiHttpContext> | null;
  /** The request's CSP nonce, applied to the page's inline `<style>`. */
  nonce?: string;
  /**
   * Send the `WWW-Authenticate: Basic …` challenge on a `401`. Default `true` (what the JSON guard
   * always did). Browsers answer that header with a native username/password prompt, which only
   * makes sense when the built-in `basic` credentials are configured — for a host gating on its own
   * `authorize` hook the prompt is noise over the page, so the SPA provider passes `false` then.
   */
  challenge?: boolean;
}

/**
 * {@link enforceGuard} for a PAGE navigation — the `@adonis-agora/telescope-ui` SPA shell and its
 * assets. Same decision ({@link runGuard}), same statuses, same "a redirect the hook wrote wins"
 * rule; what differs is the body: a browser gets the built-in access-denied page (or the host's
 * `accessDenied` customisation of it) instead of the `{ error }` JSON the API answers with. The
 * `WWW-Authenticate` challenge still rides on a `401` unless `challenge: false`, so the built-in
 * `basic` credentials keep prompting natively in a browser — the page is what shows if the prompt
 * is dismissed.
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

  const status = result.status === 401 ? 401 : 403;
  const info: AccessDeniedInfo = {
    status,
    reason: status === 401 ? 'unauthenticated' : 'forbidden',
    basePath: options.basePath,
    ...(options.loginHref !== undefined ? { loginHref: options.loginHref } : {}),
    ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
  };
  const html = await resolveAccessDeniedPage(info, options.accessDenied, ctx, answered);
  if (html === null) return false;

  ctx.response.status(status);
  if (status === 401 && options.challenge !== false) {
    ctx.response.header('WWW-Authenticate', 'Basic realm="Telescope", Bearer');
  }
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
