import { Container } from '@adonisjs/core/container';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  resolveConsoleAuthorize,
} from '../../src/ui/console_authorize.js';
import { resolveConfig } from '../../src/ui/define_config.js';
import { enforceGuard, enforcePageGuard } from '../../src/ui/guard.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';

class AuditService {
  readonly seen: string[] = [];
  record(what: string) {
    this.seen.push(what);
  }
}

/** Stands in for an `@inject()` class: the container binding below supplies its dependency. */
class ConsoleAccess implements ConsoleAuthorizer {
  constructor(private audit: AuditService) {}
  authorize(ctx: HttpContext) {
    this.audit.record('console');
    return ctx.request.header('x-admin') === 'yes';
  }
}

/** A request context with a real AdonisJS container resolver, like the one the router hands out. */
function ctx(headers: Record<string, string> = {}, container = withAudit(new AuditService())) {
  const res = new RecordingResponse();
  const c = {
    request: makeRequest('GET', {}, headers),
    response: res,
    containerResolver: container.createResolver(),
  };
  return { ctx: c as unknown as UiHttpContext, res, container };
}

/** A container that builds {@link ConsoleAccess} with its `AuditService` dependency. */
function withAudit(audit: AuditService) {
  const container = new Container();
  container.singleton(AuditService, () => audit);
  container.bind(
    ConsoleAccess,
    async (resolver) => new ConsoleAccess(await resolver.make(AuditService)),
  );
  return container;
}

describe('resolveConsoleAuthorize', () => {
  it('runs an inline function with the ctx', async () => {
    const check = resolveConsoleAuthorize((c) => c.request.header('x-admin') === 'yes');
    expect(await check(ctx({ 'x-admin': 'yes' }).ctx)).toEqual({ allowed: true });
    expect(await check(ctx().ctx)).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('builds a class through the container (DI) and calls authorize', async () => {
    const audit = new AuditService();
    const container = withAudit(audit);
    const check = resolveConsoleAuthorize(ConsoleAccess);
    expect(await check(ctx({ 'x-admin': 'yes' }, container).ctx)).toEqual({ allowed: true });
    expect(await check(ctx({}, container).ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(audit.seen).toEqual(['console', 'console']);
  });

  it('builds the class through ctx.containerResolver, so a swap wins', async () => {
    const container = new Container();
    class Denies implements ConsoleAuthorizer {
      authorize() {
        return false;
      }
    }
    container.swap(Denies, () => ({ authorize: () => true }) as unknown as Denies);
    const check = resolveConsoleAuthorize(Denies);
    expect(await check(ctx({}, container).ctx)).toEqual({ allowed: true });
  });

  it('resolves a lazy import once and builds its default class via the container', async () => {
    let imports = 0;
    const lazy = async () => {
      imports++;
      return { default: ConsoleAccess };
    };
    const check = resolveConsoleAuthorize(lazy);
    expect(await check(ctx({ 'x-admin': 'yes' }).ctx)).toEqual({ allowed: true });
    expect(await check(ctx().ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    // A second resolution of the same config (another provider) reuses the memo too.
    expect(await resolveConsoleAuthorize(lazy)(ctx({ 'x-admin': 'yes' }).ctx)).toEqual({
      allowed: true,
    });
    expect(imports).toBe(1);
  });

  it('treats a throw as a 403 denial, in every form', async () => {
    class Throws implements ConsoleAuthorizer {
      authorize(): boolean {
        throw new Error('boom');
      }
    }
    const forms: ConsoleAuthorize[] = [
      () => {
        throw new Error('boom');
      },
      Throws,
      async () => ({ default: Throws }),
      async () => {
        throw new Error('module not found');
      },
    ];
    for (const form of forms) {
      expect(await resolveConsoleAuthorize(form)(ctx().ctx)).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
    }
  });

  it('denies a class when the request has no container resolver', async () => {
    const bare = { request: makeRequest('GET'), response: new RecordingResponse() };
    expect(await resolveConsoleAuthorize(ConsoleAccess)(bare)).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it.each<[ConsoleAuthorizeResult | undefined, unknown]>([
    [true, { allowed: true }],
    [{ allowed: true }, { allowed: true }],
    [false, { allowed: false, reason: 'forbidden' }],
    [{ allowed: false }, { allowed: false, reason: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, reason: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, reason: 'unauthenticated' },
    ],
    [{ redirectTo: '/login' }, { allowed: false, reason: 'unauthenticated', redirectTo: '/login' }],
    [undefined, { allowed: false, reason: 'forbidden' }],
  ])('normalizes %j', async (result, expected) => {
    const check = resolveConsoleAuthorize(() => result as ConsoleAuthorizeResult);
    expect(await check(ctx().ctx)).toEqual(expected);
  });
});

describe('telescope_ui authorize accepts every console form', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  const gated = (authorize: ConsoleAuthorize) => resolveConfig({ authorize }).authorize;

  it.each<[string, ConsoleAuthorize]>([
    ['function', (c) => c.request.header('x-admin') === 'yes'],
    ['class', ConsoleAccess],
    ['lazy import', async () => ({ default: ConsoleAccess })],
  ])('API guard with the %s form: allowed / 403', async (_, authorize) => {
    const guard = gated(authorize);
    const container = withAudit(new AuditService());

    const ok = ctx({ 'x-admin': 'yes' }, container);
    expect(await enforceGuard(ok.ctx, guard)).toBe(true);
    expect(ok.res.sent).toBe(false);

    const denied = ctx({}, container);
    expect(await enforceGuard(denied.ctx, guard)).toBe(false);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toEqual({ error: 'Forbidden' });
  });

  it("API guard: reason 'unauthenticated' → 401", async () => {
    const { ctx: c, res } = ctx();
    const guard = gated((_ctx) => ({ allowed: false, reason: 'unauthenticated' }));
    expect(await enforceGuard(c, guard)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('API guard: { redirectTo } → 401 JSON carrying the path', async () => {
    const { ctx: c, res } = ctx();
    expect(
      await enforceGuard(
        c,
        gated((_ctx) => ({ redirectTo: '/login' })),
      ),
    ).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', redirectTo: '/login' });
    expect(res.headers.location).toBeUndefined();
  });

  it('page guard: { redirectTo } → 302 to that path', async () => {
    const { ctx: c, res } = ctx();
    const guard = gated(async () => ({ redirectTo: '/login?next=/telescope' }));
    expect(await enforcePageGuard(c, guard, { basePath: '/telescope' })).toBe(false);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?next=/telescope');
  });

  it('page guard: a throwing class → the 403 page', async () => {
    class Throws implements ConsoleAuthorizer {
      authorize(): boolean {
        throw new Error('boom');
      }
    }
    const { ctx: c, res } = ctx();
    expect(await enforcePageGuard(c, gated(Throws), { basePath: '/telescope' })).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(String(res.body)).toContain('<!doctype html>');
  });

  it('omitted authorize keeps the default: open outside production, 401 in production', async () => {
    process.env.NODE_ENV = 'development';
    const dev = ctx();
    expect(await enforceGuard(dev.ctx, resolveConfig({}).authorize)).toBe(true);

    process.env.NODE_ENV = 'production';
    const prod = ctx();
    expect(await enforceGuard(prod.ctx, resolveConfig({}).authorize)).toBe(false);
    expect(prod.res.statusCode).toBe(401);
  });
});
