import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAuthorize, resolveConfig } from '../../src/ui/define_config.js';
import { enforceGuard, enforcePageGuard, runGuard } from '../../src/ui/guard.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';

function ctx(
  qs: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', qs, headers), response: res }, res };
}

describe('runGuard', () => {
  it('allows when authorize returns true', async () => {
    const { ctx: c } = ctx();
    expect(await runGuard(c, () => true)).toEqual({ allowed: true });
  });

  it('401s when denied and no credential was presented', async () => {
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => false);
    expect(result).toEqual({ allowed: false, status: 401, message: 'Unauthorized' });
  });

  it('403s when denied but a credential WAS presented', async () => {
    const { ctx: c } = ctx({}, { authorization: 'Bearer wrong' });
    const result = await runGuard(c, () => false);
    expect(result.status).toBe(403);
  });

  it('fails closed (403) when authorize throws', async () => {
    const { ctx: c } = ctx();
    const result = await runGuard(c, () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ allowed: false, status: 403, message: 'Forbidden' });
  });

  it('awaits an async authorize hook', async () => {
    const { ctx: c } = ctx();
    expect((await runGuard(c, async () => true)).allowed).toBe(true);
  });
});

describe('enforceGuard', () => {
  it('returns true and leaves the response untouched when allowed', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, () => true)).toBe(true);
    expect(res.sent).toBe(false);
  });

  it('writes 401 + WWW-Authenticate when denied with no credential', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforceGuard(c, () => false)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
    expect((res.body as { error: string }).error).toBe('Unauthorized');
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
});

describe('default authorize policy', () => {
  const ORIGINAL = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL;
  });

  it('allows outside production when no credentials are configured', async () => {
    process.env.NODE_ENV = 'development';
    const authorize = defaultAuthorize({});
    const { ctx: c } = ctx();
    expect(await authorize(c)).toBe(true);
  });

  it('denies in production when no credentials are configured (default-deny)', async () => {
    process.env.NODE_ENV = 'production';
    const authorize = defaultAuthorize({});
    const { ctx: c } = ctx();
    expect(await authorize(c)).toBe(false);
  });

  it('allows in production with a matching bearer token', async () => {
    process.env.NODE_ENV = 'production';
    const authorize = defaultAuthorize({ token: 'secret' });
    const { ctx: ok } = ctx({}, { authorization: 'Bearer secret' });
    const { ctx: bad } = ctx({}, { authorization: 'Bearer nope' });
    expect(await authorize(ok)).toBe(true);
    expect(await authorize(bad)).toBe(false);
  });

  it('allows in production with a matching ?token query param', async () => {
    process.env.NODE_ENV = 'production';
    const authorize = defaultAuthorize({ token: 'secret' });
    const { ctx: c } = ctx({ token: 'secret' });
    expect(await authorize(c)).toBe(true);
  });

  it('allows in production with matching HTTP Basic credentials', async () => {
    process.env.NODE_ENV = 'production';
    const authorize = defaultAuthorize({ basic: { username: 'admin', password: 'pw' } });
    const good = Buffer.from('admin:pw').toString('base64');
    const bad = Buffer.from('admin:wrong').toString('base64');
    expect(await authorize(ctx({}, { authorization: `Basic ${good}` }).ctx)).toBe(true);
    expect(await authorize(ctx({}, { authorization: `Basic ${bad}` }).ctx)).toBe(false);
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
    process.env.NODE_ENV = 'production';
    const resolved = resolveConfig({ authorize: () => true });
    const { ctx: c } = ctx();
    expect(await resolved.authorize(c)).toBe(true);
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

  it('serves the 401 page (still with WWW-Authenticate) when no credential was presented', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, () => false, options)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store, must-revalidate');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<h1>Sign in required</h1>');
    expect(res.body).toContain('Telescope');
  });

  it('drops the WWW-Authenticate challenge when told to (no basic credentials to answer it)', async () => {
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, () => false, { ...options, challenge: false })).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toContain('<h1>Sign in required</h1>');
  });

  it('serves the 403 page when a credential was presented and rejected', async () => {
    const { ctx: c, res } = ctx({}, { authorization: 'Bearer nope' });
    expect(await enforcePageGuard(c, () => false, options)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toContain('<h1>Access denied</h1>');
  });

  it('offers the built-in login page when dashboardAuth exists', async () => {
    const { ctx: c, res } = ctx();
    await enforcePageGuard(c, () => false, { ...options, loginHref: '/telescope/login' });
    expect(res.body).toContain('href="/telescope/login"');
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
    await enforcePageGuard(c, () => false, {
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
