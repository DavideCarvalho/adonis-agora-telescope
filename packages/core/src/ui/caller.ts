import { createHash } from 'node:crypto';
import type { UiHttpContext } from './http.js';

/**
 * Who is calling a console route, for audit trails. Never a token value:
 * - a signed-in user (`ctx.auth.user`, read without authenticating) → `user:<id>`;
 * - a `Authorization: Bearer` token → `token:` + the first 12 hex of its sha256;
 * - neither → `anonymous`.
 */
export function callerOf(ctx: UiHttpContext): { id: string } {
  const user = (ctx as { auth?: { user?: { id?: unknown } | null } }).auth?.user;
  const userId = user?.id;
  if (typeof userId === 'string' || typeof userId === 'number') return { id: `user:${userId}` };
  const auth = ctx.request.header('authorization');
  const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  if (match?.[1]) {
    const digest = createHash('sha256').update(match[1]).digest('hex');
    return { id: `token:${digest.slice(0, 12)}` };
  }
  return { id: 'anonymous' };
}
