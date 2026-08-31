import { describe, expect, it } from 'vitest';
import {
  type DashboardAuthOptions,
  decideDashboardAuth,
  performLogin,
  type ResolvedDashboardAuth,
  readSession,
  resolveDashboardAuth,
  sanitizeReturnTo,
} from '../../src/ui/auth.js';
import { renderLoginPage } from '../../src/ui/login_page.js';
import { signSessionCookie, verifySessionCookie } from '../../src/ui/session_cookie.js';

const SECRET = 'test-secret-key-at-least-32-bytes-long-ok';
const TTL_MS = 8 * 60 * 60 * 1000;

function resolved(overrides: Partial<DashboardAuthOptions> = {}): ResolvedDashboardAuth {
  return resolveDashboardAuth({
    secret: SECRET,
    login: async (u, p) => (u === 'admin' && p === 'pw' ? { id: 'u1', name: 'Admin' } : null),
    ...overrides,
  }) as ResolvedDashboardAuth;
}

describe('session_cookie: sign / verify', () => {
  it('round-trips a signed session', () => {
    const now = 1_000_000;
    const value = signSessionCookie(
      { id: 'u1', name: 'Ada', roles: ['admin'] },
      {
        secret: SECRET,
        ttlMs: TTL_MS,
        now,
      },
    );
    const session = verifySessionCookie(value, { secret: SECRET, now });
    expect(session).not.toBeNull();
    expect(session?.sub).toBe('u1');
    expect(session?.name).toBe('Ada');
    expect(session?.roles).toEqual(['admin']);
    expect(session?.exp).toBe(now + TTL_MS);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS });
    const [payload, sig] = value.split('.');
    const forged = `${Buffer.from('{"sub":"root","roles":[],"iat":0,"exp":9999999999999}').toString(
      'base64url',
    )}.${sig}`;
    expect(verifySessionCookie(forged, { secret: SECRET })).toBeNull();
    // A flipped signature is also rejected.
    expect(verifySessionCookie(`${payload}.${sig}x`, { secret: SECRET })).toBeNull();
  });

  it('rejects a session signed with a different secret', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS });
    expect(verifySessionCookie(value, { secret: 'another-secret' })).toBeNull();
  });

  it('rejects an expired session (past exp + grace)', () => {
    const now = 1_000_000;
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: 1000, now });
    // Within grace → still valid.
    expect(verifySessionCookie(value, { secret: SECRET, now: now + 1000 + 20_000 })).not.toBeNull();
    // Past exp + 30s grace → rejected.
    expect(verifySessionCookie(value, { secret: SECRET, now: now + 1000 + 40_000 })).toBeNull();
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', '.', 'nodot', 'a.', '.b', 'a.b.c']) {
      expect(verifySessionCookie(bad, { secret: SECRET })).toBeNull();
    }
  });
});

describe('resolveDashboardAuth', () => {
  it('returns null when unconfigured (behavior unchanged)', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('fails closed when secret is missing/empty', () => {
    expect(() =>
      resolveDashboardAuth({ secret: '', login: () => null } as DashboardAuthOptions),
    ).toThrow(/secret is required/);
  });

  it('fails closed when login hook is missing', () => {
    expect(() =>
      resolveDashboardAuth({ secret: SECRET } as unknown as DashboardAuthOptions),
    ).toThrow(/login is required/);
  });

  it('parses the ttl duration string, defaulting to 8h', () => {
    expect(resolveDashboardAuth({ secret: SECRET, login: () => null })?.ttlMs).toBe(TTL_MS);
    expect(resolveDashboardAuth({ secret: SECRET, ttl: '30m', login: () => null })?.ttlMs).toBe(
      30 * 60 * 1000,
    );
    // Bad duration falls back to the 8h default.
    expect(resolveDashboardAuth({ secret: SECRET, ttl: 'nope', login: () => null })?.ttlMs).toBe(
      TTL_MS,
    );
  });
});

describe('performLogin', () => {
  it('mints a cookie on correct credentials and sanitizes returnTo', async () => {
    const auth = resolved();
    const outcome = await performLogin(
      auth,
      { username: 'admin', password: 'pw', returnTo: '/telescope/entries' },
      '/telescope',
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.redirectTo).toBe('/telescope/entries');
    expect(readSession(auth, outcome.cookieValue)?.sub).toBe('u1');
  });

  it('falls back to basePath for an open-redirect returnTo', async () => {
    const auth = resolved();
    const outcome = await performLogin(
      auth,
      { username: 'admin', password: 'pw', returnTo: 'https://evil.com' },
      '/telescope',
    );
    expect(outcome.kind === 'ok' && outcome.redirectTo).toBe('/telescope');
  });

  it('uniform 401 on wrong password (no user-enumeration)', async () => {
    const outcome = await performLogin(resolved(), { username: 'admin', password: 'wrong' }, '/t');
    expect(outcome.kind).toBe('unauthorized');
  });

  it('forwards an empty password AS-IS so the hook decides (email-only host)', async () => {
    // Host ignores password entirely, gates on username.
    const auth = resolved({ login: (u) => (u === 'admin' ? { id: 'u1' } : null) });
    const outcome = await performLogin(auth, { username: 'admin', password: '' }, '/t');
    expect(outcome.kind).toBe('ok');
  });

  it('400s when the body is missing string username/password', async () => {
    const outcome = await performLogin(resolved(), { username: 'admin' }, '/t');
    expect(outcome.kind).toBe('bad-request');
  });

  it('treats a throwing hook as a uniform denial and surfaces hookError', async () => {
    const auth = resolved({
      login: () => {
        throw new Error('db down');
      },
    });
    const outcome = await performLogin(auth, { username: 'a', password: 'b' }, '/t');
    expect(outcome.kind).toBe('unauthorized');
    if (outcome.kind !== 'unauthorized') throw new Error('expected unauthorized');
    expect(outcome.hookError).toBeInstanceOf(Error);
  });
});

describe('decideDashboardAuth (composed session guard)', () => {
  const auth = resolved();

  it('allows unconditionally when unconfigured (auth === null) — unchanged behavior', () => {
    expect(decideDashboardAuth(null, undefined, 'page', '/telescope')).toEqual({ kind: 'allow' });
    expect(decideDashboardAuth(null, undefined, 'api', '/telescope/api/entries')).toEqual({
      kind: 'allow',
    });
  });

  it('redirects an unauthenticated page navigation, carrying returnTo', () => {
    const decision = decideDashboardAuth(auth, undefined, 'page', '/telescope/entries');
    expect(decision).toEqual({ kind: 'redirect', returnTo: '/telescope/entries' });
  });

  it('401s an unauthenticated api request', () => {
    expect(decideDashboardAuth(auth, undefined, 'api', '/telescope/api/entries')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('allows a request carrying a valid session cookie', () => {
    const cookie = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS });
    expect(decideDashboardAuth(auth, cookie, 'page', '/telescope')).toEqual({ kind: 'allow' });
    expect(decideDashboardAuth(auth, cookie, 'api', '/telescope/api/entries')).toEqual({
      kind: 'allow',
    });
  });

  it('rejects a tampered cookie (page → redirect, api → 401)', () => {
    const tampered = 'garbage.value';
    expect(decideDashboardAuth(auth, tampered, 'page', '/telescope').kind).toBe('redirect');
    expect(decideDashboardAuth(auth, tampered, 'api', '/telescope/api').kind).toBe('unauthorized');
  });
});

describe('sanitizeReturnTo', () => {
  it('accepts a same-origin root-relative path', () => {
    expect(sanitizeReturnTo('/telescope/entries', '/telescope')).toBe('/telescope/entries');
  });

  it('rejects protocol-relative, absolute, and non-string values', () => {
    expect(sanitizeReturnTo('//evil.com', '/telescope')).toBe('/telescope');
    expect(sanitizeReturnTo('https://evil.com', '/telescope')).toBe('/telescope');
    expect(sanitizeReturnTo('relative', '/telescope')).toBe('/telescope');
    expect(sanitizeReturnTo(undefined, '/telescope')).toBe('/telescope');
    expect(sanitizeReturnTo(42, '/telescope')).toBe('/telescope');
  });
});

describe('renderLoginPage', () => {
  it('renders a static page wired to POST <basePath>/login', () => {
    const html = renderLoginPage('/telescope');
    expect(html).toContain('<title>Sign in — Telescope</title>');
    expect(html).toContain('"/telescope/login"');
    // Password input is NOT required (host hook decides).
    expect(html).not.toMatch(/id="password"[^>]*\brequired\b/);
  });
});
