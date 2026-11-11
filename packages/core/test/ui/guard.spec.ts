import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig as resolveMcpConfig } from '../../src/mcp/define_config.js';
import { authorizeByToken } from '../../src/mcp/index.js';
import { type AuthorizeDecision, resolveConfig } from '../../src/ui/define_config.js';
import { enforceGuard, enforcePageGuard, runGuard } from '../../src/ui/guard.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';

function ctx(
  qs: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', qs, headers), response: res }, res };
}

/** A custom hook that explicitly asks for the 401 "please sign in" answer. */
const unauthenticated = (): AuthorizeDecision => ({ allowed: false, reason: 'unauthenticated' });

describe('runGuard', () => {
  it('allows when authorize returns true', async () => {
    const { ctx: c } = ctx();
    expect(await runGuard(c, () => true)).toEqual({ allowed: true });
  });

  it('403s on a bare false even when no credential was presented (fail closed, no guessing)', async () => {
    // The production bug: a session-authenticated user without the ADMIN role carries no
    // Authorization header/?token, and the old request-shape heuristic answered 401 "Sign in".
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => false);
    expect(result).toEqual({ allowed: false, status: 403, message: 'forbidden' });
  });

  it('403s on a bare false when a credential WAS presented', async () => {
    const { ctx: c } = ctx({}, { authorization: 'Bearer wrong' });
    const result = await runGuard(c, () => false);
    expect(result.status).toBe(403);
  });

  it('fails closed (403) when authorize throws', async () => {
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ allowed: false, status: 403, message: 'forbidden' });
  });

  it('awaits an async authorize hook', async () => {
    const { ctx: c } = ctx();
    expect((await runGuard(c, async () => true)).allowed).toBe(true);
  });
});

describe('runGuard with an enriched AuthorizeDecision return', () => {
  it('allows when the decision object says allowed: true (no credential in the request)', async () => {
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => ({ allowed: true }));
    expect(result).toEqual({ allowed: true });
  });

  it("403s on reason: 'forbidden' even though NO credential was presented — the whole point", async () => {
    // This is the authorizeByRoles case: a session-cookie-authenticated-but-wrong-role request
    // carries no Authorization header/?token, so the request-shape heuristic alone would say 401.
    // An explicit reason overrides that heuristic.
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => ({ allowed: false, reason: 'forbidden' }));
    expect(result).toEqual({ allowed: false, status: 403, message: 'forbidden' });
  });

  it("401s on reason: 'unauthenticated' even when a credential WAS presented", async () => {
    // An explicit reason overrides the heuristic in both directions.
    const { ctx: c } = ctx({}, { authorization: 'Bearer whatever' });
    const result = await runGuard(c, () => ({ allowed: false, reason: 'unauthenticated' }));
    expect(result).toEqual({ allowed: false, status: 401, message: 'unauthenticated' });
  });

  it('403s when allowed: false has no reason, whatever the request looks like', async () => {
    const { ctx: noCredential } = ctx();
    const { ctx: withCredential } = ctx({ token: 'nope' });
    expect(await runGuard(noCredential, () => ({ allowed: false }))).toEqual({
      allowed: false,
      status: 403,
      message: 'forbidden',
    });
    expect((await runGuard(withCredential, () => ({ allowed: false }))).status).toBe(403);
  });

  it('awaits an async hook returning an AuthorizeDecision', async () => {
    const { ctx: c } = ctx();
    const result = await runGuard(c, async () => ({ allowed: false, reason: 'forbidden' }));
    expect(result.status).toBe(403);
  });
});

describe('enforceGuard', () => {
  it('returns true and leaves the response untouched when allowed', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, () => true)).toBe(true);
    expect(res.sent).toBe(false);
  });

  it("writes 401 + WWW-Authenticate when the hook says reason: 'unauthenticated'", async () => {
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, unauthenticated)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="Telescope"');
    expect(res.body).toEqual({ error: 'unauthenticated' });
  });

  it('writes 403 JSON (no challenge) when a custom hook returns a bare false with no credential', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, () => false)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect((res.body as { error: string }).error).toBe('forbidden');
  });

  it('writes 403 when a credential was presented and rejected', async () => {
    const { ctx: c, res } = ctx({ token: 'nope' });
    expect(await enforceGuard(c, () => false)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('skips its own 401 JSON when authorize already redirected (unauthenticated)', async () => {
    const { ctx: c, res } = ctx();
    const denied = await enforceGuard(c, (context) => {
      context.response.status(302).header('location', '/login');
      return false;
    });
    expect(denied).toBe(false);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(res.sent).toBe(false);
  });

  it('skips its own 403 JSON when authorize already redirected (credential rejected)', async () => {
    const { ctx: c, res } = ctx({ token: 'nope' });
    const denied = await enforceGuard(c, (context) => {
      context.response.status(302).header('location', '/acesso-negado');
      return false;
    });
    expect(denied).toBe(false);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/acesso-negado');
    expect(res.sent).toBe(false);
  });

  it("writes 403 (not the heuristic's 401) when a session-based hook signals reason: 'forbidden'", async () => {
    // The authorizeByRoles bug this fix addresses: an authenticated-but-wrong-role request that
    // carries no Authorization header/?token used to be mis-reported as 401.
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, () => ({ allowed: false, reason: 'forbidden' }))).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect((res.body as { error: string }).error).toBe('forbidden');
  });
});

describe('resolveConfig', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('defaults path to /telescope and normalizes a custom path', () => {
    expect(resolveConfig().path).toBe('/telescope');
    expect(resolveConfig({ path: 'admin/scope/' }).path).toBe('/admin/scope');
  });

  it('uses the supplied authorize hook over the default policy', async () => {
    const resolved = resolveConfig({ authorize: () => true }, { inProduction: true });
    const { ctx: c } = ctx();
    expect(await resolved.authorize(c)).toEqual({ allowed: true });
    expect(resolved.authorizeConfigured).toBe(true);
  });

  it('without authorize: open outside production', async () => {
    const resolved = resolveConfig({}, { inProduction: false });
    expect(resolved.authorizeConfigured).toBe(false);
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, resolved.authorize)).toBe(true);
    expect(res.sent).toBe(false);
  });

  it('without authorize: 403 on every API and page request in production, whatever is presented', async () => {
    const { authorize } = resolveConfig({}, { inProduction: true });
    for (const headers of [{}, { authorization: 'Bearer anything' }]) {
      const api = ctx({ token: 'anything' }, headers);
      expect(await enforceGuard(api.ctx, authorize)).toBe(false);
      expect(api.res.statusCode).toBe(403);
      expect(api.res.body).toEqual({ error: 'forbidden' });
      const page = ctx({}, headers);
      expect(await enforcePageGuard(page.ctx, authorize, { basePath: '/telescope' })).toBe(false);
      expect(page.res.statusCode).toBe(403);
      expect(page.res.body).toContain('<h1>Access denied</h1>');
    }
  });

  it('without the option, production is read from NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    expect(await runGuard(ctx().ctx, resolveConfig().authorize)).toMatchObject({ status: 403 });
    process.env.NODE_ENV = 'development';
    expect(await runGuard(ctx().ctx, resolveConfig().authorize)).toEqual({ allowed: true });
  });

  it('no longer reads the removed credentials option', async () => {
    const legacy = { credentials: { token: 'secret' } } as unknown as Parameters<
      typeof resolveConfig
    >[0];
    const resolved = resolveConfig(legacy, { inProduction: true });
    expect(resolved).not.toHaveProperty('credentials');
    const { ctx: c } = ctx({ token: 'secret' }, { authorization: 'Bearer secret' });
    expect(await runGuard(c, resolved.authorize)).toMatchObject({ status: 403 });
  });

  it('defaults enabled to true', () => {
    expect(resolveConfig().enabled).toBe(true);
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('enforcePageGuard (a BROWSER is refused with a page, not JSON)', () => {
  const options = { basePath: '/telescope' };

  it('returns true and leaves the response untouched when allowed', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, () => true, options)).toBe(true);
    expect(res.sent).toBe(false);
  });

  it('serves the 403 page when a custom hook returns a bare false with no credential', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, () => false, options)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Access denied</h1>');
  });

  it("serves the 403 page when the hook says reason: 'forbidden'", async () => {
    const { ctx: c, res } = ctx();
    expect(
      await enforcePageGuard(c, () => ({ allowed: false, reason: 'forbidden' }), options),
    ).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('<h1>Access denied</h1>');
  });

  it("serves the 401 page (no browser auth prompt) on reason: 'unauthenticated'", async () => {
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, unauthenticated, options)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store, must-revalidate');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<h1>Sign in required</h1>');
    expect(res.body).toContain('Telescope');
  });

  it('serves the 403 page when a credential was presented and rejected', async () => {
    const { ctx: c, res } = ctx({}, { authorization: 'Bearer nope' });
    expect(await enforcePageGuard(c, () => false, options)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toContain('<h1>Access denied</h1>');
  });

  it("points Sign in at the app's own login page from accessDenied.loginHref", async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(c, () => ({ allowed: false, reason: 'unauthenticated' }), {
      ...options,
      accessDenied: { loginHref: '/login' },
    });
    expect(res.body).toContain('href="/login"');
    expect(res.body).not.toContain('/telescope/login');
  });

  it('honours the accessDenied options object', async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(c, () => false, {
      ...options,
      accessDenied: { title: 'Sem acesso', brand: 'Entre Textos', homeHref: '/admin' },
    });
    expect(res.body).toContain('<h1>Sem acesso</h1>');
    expect(res.body).toContain('Entre Textos');
    expect(res.body).toContain('href="/admin"');
  });

  it('serves whatever an accessDenied renderer returns, with the refusal info and the ctx', async () => {
    const { ctx: c, res } = ctx();
    let seen: unknown[] = [];
    await enforcePageGuard(c, unauthenticated, {
      ...options,
      accessDenied: (info, context) => {
        seen = [info, context];
        return '<p>custom</p>';
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('<p>custom</p>');
    expect(seen[0]).toEqual({ status: 401, reason: 'unauthenticated', basePath: '/telescope' });
    expect(seen[1]).toBe(c);
  });

  it('stands down when the renderer answered the request itself', async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(c, () => false, {
      ...options,
      accessDenied: (_info, context) => {
        context.response.status(302).header('location', '/login');
      },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(res.sent).toBe(false);
  });

  it('keeps a redirect the authorize hook already wrote', async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(
      c,
      (context) => {
        context.response.status(302).header('location', '/login');
        return false;
      },
      options,
    );
    expect(res.statusCode).toBe(302);
    expect(res.sent).toBe(false);
  });

  it('puts the CSP nonce on the inline <style>', async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(c, () => false, { ...options, nonce: 'n0nce' });
    expect(res.body).toContain('<style nonce="n0nce">');
  });
});

describe('the MCP endpoint uses the console authorize contract', () => {
  it('is open outside production and 403s every request in production when omitted', async () => {
    const dev = resolveMcpConfig({}, { inProduction: false });
    expect(dev.authorizeConfigured).toBe(false);
    expect(await runGuard(ctx().ctx, dev.authorize)).toEqual({ allowed: true });

    const prod = resolveMcpConfig({}, { inProduction: true });
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, prod.authorize)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('authorizeByToken: 401 JSON without the Bearer token, allowed with it, no ?token=', async () => {
    const { authorize, authorizeConfigured } = resolveMcpConfig(
      { authorize: authorizeByToken({ token: 'secret' }) },
      { inProduction: true },
    );
    expect(authorizeConfigured).toBe(true);

    const missing = ctx();
    expect(await enforceGuard(missing.ctx, authorize)).toBe(false);
    expect(missing.res.statusCode).toBe(401);
    expect(missing.res.body).toEqual({ error: 'unauthenticated' });

    expect(await runGuard(ctx({}, { authorization: 'Bearer nope' }).ctx, authorize)).toMatchObject({
      allowed: false,
      status: 401,
    });
    expect(await runGuard(ctx({ token: 'secret' }).ctx, authorize)).toMatchObject({
      allowed: false,
    });
    const basic = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
    expect(await runGuard(ctx({}, { authorization: basic }).ctx, authorize)).toMatchObject({
      allowed: false,
    });
    expect(await runGuard(ctx({}, { authorization: 'Bearer secret' }).ctx, authorize)).toEqual({
      allowed: true,
    });
  });

  it('a custom authorize returning false is a 403 JSON', async () => {
    const { authorize } = resolveMcpConfig({ authorize: () => false }, { inProduction: false });
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, authorize)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('drops the removed credentials option', () => {
    const config = resolveMcpConfig({}, { inProduction: false }) as unknown as Record<
      string,
      unknown
    >;
    expect('credentials' in config).toBe(false);
  });
});
