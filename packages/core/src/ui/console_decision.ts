import {
  type ConsoleAccess,
  type ConsoleAuthorizeDecision,
  normalizeConsoleAuthorizeResult,
} from './console_authorize.js';

/**
 * Telescope's extras over the shared console access contract (`console_authorize.ts`, kept
 * byte-identical across the libs): the single decision shape the guard works with.
 */

/** What the guard acts on: an allow (with its narrowing) or a denial (with a redirect, if any). */
export type NormalizedDecision =
  | {
      allowed: true;
      apps?: '*' | string[];
      tenants?: '*' | string[];
      capabilities?: string[];
      access?: ConsoleAccess;
    }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/**
 * Map an `authorize` answer, or a decision the shared resolver already normalized
 * ({@link ConsoleAuthorizeDecision}, with its `status`), onto a {@link NormalizedDecision}.
 * Anything unrecognised denies.
 */
export function normalizeConsoleDecision(result: unknown): NormalizedDecision {
  const value = result as Partial<Extract<ConsoleAuthorizeDecision, { allowed: false }>> | null;
  // An already-normalized redirect (`{ allowed: false, status: 302, redirectTo }`).
  if (
    value !== null &&
    typeof value === 'object' &&
    value.allowed === false &&
    typeof (value as { redirectTo?: unknown }).redirectTo === 'string' &&
    (value as { redirectTo: string }).redirectTo !== ''
  ) {
    return {
      allowed: false,
      reason: 'unauthenticated',
      redirectTo: (value as { redirectTo: string }).redirectTo,
    };
  }
  const decision = normalizeConsoleAuthorizeResult(result);
  if (decision.allowed) return decision;
  if (decision.status === 302) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: decision.redirectTo };
  }
  return { allowed: false, reason: decision.status === 401 ? 'unauthenticated' : 'forbidden' };
}

/** The error a shared-resolver denial carries when the `authorize` check threw. */
export function thrownBy(result: unknown): unknown {
  return result !== null &&
    typeof result === 'object' &&
    (result as { allowed?: unknown }).allowed === false &&
    'error' in result
    ? (result as { error: unknown }).error
    : undefined;
}
