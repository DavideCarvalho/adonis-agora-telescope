import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { csrfTokenOf, resolveSignOut, resolveViewer, viewerFromUser } from './console_shell.js';
import { resolveDashboardConfig } from './define_config.js';

function ctx(extra: { user?: unknown; csrfToken?: unknown; throwOnUser?: boolean } = {}) {
  const auth = extra.throwOnUser
    ? {
        get user(): unknown {
          throw new Error('not authenticated');
        },
      }
    : 'user' in extra
      ? { user: extra.user }
      : undefined;
  return {
    ...(auth ? { auth } : {}),
    request: { csrfToken: extra.csrfToken },
  } as unknown as HttpContext;
}

describe('viewerFromUser', () => {
  it('prefers fullName, then name, then email for the label; first role wins', () => {
    expect(
      viewerFromUser({ fullName: 'Ann Lee', email: 'ann@x.test', roles: ['admin', 'ops'] }),
    ).toEqual({ label: 'Ann Lee', email: 'ann@x.test', role: 'admin' });
    expect(viewerFromUser({ name: 'Bo', roles: [{ name: 'support' }] })).toEqual({
      label: 'Bo',
      role: 'support',
    });
    expect(viewerFromUser({ email: 'c@x.test', role: 'viewer' })).toEqual({
      label: 'c@x.test',
      email: 'c@x.test',
      role: 'viewer',
    });
  });

  it('is undefined for nothing usable', () => {
    expect(viewerFromUser(undefined)).toBeUndefined();
    expect(viewerFromUser({ id: 1 })).toBeUndefined();
    expect(viewerFromUser({ name: '  ' })).toBeUndefined();
  });
});

describe('resolveViewer', () => {
  it('reads ctx.auth.user structurally when no hook is configured', async () => {
    expect(await resolveViewer(ctx({ user: { email: 'a@x.test' } }), null)).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
    expect(await resolveViewer(ctx(), null)).toBeUndefined();
    expect(await resolveViewer(ctx({ user: null }), null)).toBeUndefined();
    expect(await resolveViewer(ctx({ throwOnUser: true }), null)).toBeUndefined();
  });

  it('uses the hook when configured, cleaning its answer; a throw means no viewer', async () => {
    const c = ctx({ user: { email: 'ignored@x.test' } });
    expect(await resolveViewer(c, async () => ({ label: ' Ops ', role: 'admin' }))).toEqual({
      label: 'Ops',
      role: 'admin',
    });
    expect(await resolveViewer(c, () => null)).toBeUndefined();
    expect(await resolveViewer(c, () => ({ label: '' }))).toBeUndefined();
    expect(
      await resolveViewer(c, () => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
  });
});

describe('resolveSignOut', () => {
  const registry = { version: 1, entries: [], account: { signOut: '/account/logout' } };

  it('uses the configured option first, with the CSRF token on a POST action', () => {
    expect(resolveSignOut(ctx({ csrfToken: 'tok' }), '/logout', registry)).toEqual({
      action: '/logout',
      csrfToken: 'tok',
    });
    expect(resolveSignOut(ctx(), { href: '/bye' }, registry)).toEqual({ href: '/bye' });
    expect(resolveSignOut(ctx(), false, registry)).toBeUndefined();
  });

  it('falls back to the sign-out an account console announced on the registry', () => {
    expect(resolveSignOut(ctx({ csrfToken: 'tok' }), null, registry)).toEqual({
      action: '/account/logout',
      csrfToken: 'tok',
    });
    expect(
      resolveSignOut(ctx(), null, {
        version: 1,
        entries: [],
        account: { signOut: { href: '/out' } },
      }),
    ).toEqual({ href: '/out' });
    expect(resolveSignOut(ctx(), null, { version: 1, entries: [] })).toBeUndefined();
    expect(resolveSignOut(ctx(), null, undefined)).toBeUndefined();
  });

  it('never emits anything but a same-origin path', () => {
    expect(resolveSignOut(ctx(), 'https://evil.example/out', undefined)).toBeUndefined();
    expect(resolveSignOut(ctx(), { href: '//evil.example' }, undefined)).toBeUndefined();
    expect(resolveSignOut(ctx(), '/\\evil', undefined)).toBeUndefined();
    expect(
      resolveSignOut(ctx(), null, { account: { signOut: 'javascript:alert(1)' } }),
    ).toBeUndefined();
  });

  it('reads the CSRF token only when it is a non-empty string', () => {
    expect(csrfTokenOf(ctx({ csrfToken: 'x' }))).toBe('x');
    expect(csrfTokenOf(ctx({ csrfToken: '' }))).toBeUndefined();
    expect(csrfTokenOf(ctx({ csrfToken: 3 }))).toBeUndefined();
  });
});

describe('resolveDashboardConfig: viewer / signOut', () => {
  it('defaults both to null and keeps what the host set', () => {
    expect(resolveDashboardConfig(undefined)).toEqual({
      enabled: true,
      viewer: null,
      signOut: null,
    });
    const hook = () => null;
    expect(resolveDashboardConfig({ path: '/t', viewer: hook, signOut: false })).toEqual({
      enabled: true,
      path: '/t',
      viewer: hook,
      signOut: false,
    });
  });
});
