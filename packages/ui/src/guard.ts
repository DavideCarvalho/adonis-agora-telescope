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
 */
export async function enforceGuard(ctx: UiHttpContext, authorize: AuthorizeHook): Promise<boolean> {
  const result = await runGuard(ctx, authorize);
  if (result.allowed) return true;
  const status = result.status ?? 403;
  ctx.response.status(status);
  if (status === 401) {
    ctx.response.header('WWW-Authenticate', 'Basic realm="Telescope", Bearer');
  }
  ctx.response.send({ error: result.message ?? 'Forbidden' });
  return false;
}
