import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopePaused,
  setTelescopeRuntime,
} from '../src/registry.js';
import { type HttpContextLike, recordRequest } from '../src/request_watcher.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import TelescopeMiddleware from '../src/telescope_middleware.js';

function stubCtx(): HttpContextLike {
  return {
    request: { method: () => 'GET', url: () => '/' },
    response: { statusCode: 200 },
  };
}

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const c = resolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.store).toBe('memory');
    expect(c.maxEntries).toBe(1000);
    expect(c.watchers.has('request')).toBe(true);
    expect(c.watchers.has('diagnostics')).toBe(true);
  });

  it('respects overrides', () => {
    const c = resolveConfig({ enabled: false, maxEntries: 50, watchers: ['diagnostics'] });
    expect(c.enabled).toBe(false);
    expect(c.maxEntries).toBe(50);
    expect(c.watchers.has('request')).toBe(false);
    expect(c.watchers.has('diagnostics')).toBe(true);
  });

  it('defaults diagnostics.exclude to an empty list', () => {
    expect(resolveConfig().diagnostics.exclude).toEqual([]);
  });

  it('threads diagnostics.exclude through the resolved config', () => {
    const c = resolveConfig({ diagnostics: { exclude: ['media:upload.progress'] } });
    expect(c.diagnostics.exclude).toEqual(['media:upload.progress']);
  });

  it('preserves a supplied store instance', () => {
    const store = new InMemoryTelescopeStore();
    const c = resolveConfig({ store });
    expect(c.store).toBe(store);
  });

  it('enables redaction with an empty extra-keys set by default', () => {
    const c = resolveConfig();
    expect(c.redact.enabled).toBe(true);
    expect(c.redact.keys).toEqual([]);
  });

  it('respects redaction overrides', () => {
    const c = resolveConfig({ redact: { enabled: false, keys: ['ssn'] } });
    expect(c.redact.enabled).toBe(false);
    expect(c.redact.keys).toEqual(['ssn']);
  });

  it('enables the live stream by default', () => {
    expect(resolveConfig().stream.enabled).toBe(true);
  });

  it('respects a disabled stream override', () => {
    expect(resolveConfig({ stream: { enabled: false } }).stream.enabled).toBe(false);
  });

  it('leaves the pruner off by default, on with defaults once a block is present', () => {
    expect(resolveConfig().prune.enabled).toBe(false);
    const c = resolveConfig({ prune: { after: '7d', keepLast: 5 } });
    expect(c.prune.enabled).toBe(true);
    expect(c.prune.afterMs).toBe(7 * 86_400_000);
    expect(c.prune.keepLast).toBe(5);
    expect(c.prune.intervalMs).toBe(60_000);
  });

  it('keeps a prune block but honours enabled:false', () => {
    expect(resolveConfig({ prune: { enabled: false, after: '1h' } }).prune.enabled).toBe(false);
  });

  it('throws at resolution on an unparseable prune duration', () => {
    expect(() => resolveConfig({ prune: { after: 'soon' } })).toThrow(/Invalid duration/);
  });

  it('enables the overload guard by default at a 200ms threshold', () => {
    const o = resolveConfig().overload;
    expect(o.enabled).toBe(true);
    expect(o.maxEventLoopLagMs).toBe(200);
    expect(o.startupGraceMs).toBe(5_000);
  });

  it('respects overload overrides and clamps a negative grace to zero', () => {
    const o = resolveConfig({
      overload: { enabled: false, maxEventLoopLagMs: 500, startupGraceMs: -1 },
    }).overload;
    expect(o.enabled).toBe(false);
    expect(o.maxEventLoopLagMs).toBe(500);
    expect(o.startupGraceMs).toBe(0);
  });
});

describe('TelescopeMiddleware', () => {
  afterEach(() => resetTelescopeRuntime());

  it('is a no-op when runtime has no store', async () => {
    resetTelescopeRuntime();
    const mw = new TelescopeMiddleware();
    let called = false;
    await mw.handle(stubCtx() as never, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(getTelescopeRuntime().store).toBeNull();
  });

  it('records a request when the request watcher is enabled', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    const mw = new TelescopeMiddleware();
    await mw.handle(stubCtx() as never, async () => {});
    expect(await store.list({ type: 'request' })).toHaveLength(1);
  });

  it('does not record when the request watcher is disabled', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, false);
    const mw = new TelescopeMiddleware();
    await mw.handle(stubCtx() as never, async () => {});
    expect(await store.count()).toBe(0);
  });

  it('sheds recording while the overload guard has paused ingestion', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    setTelescopePaused(true);
    const mw = new TelescopeMiddleware();
    let called = false;
    await mw.handle(stubCtx() as never, async () => {
      called = true;
    });
    expect(called).toBe(true); // the request itself still flows through
    expect(await store.count()).toBe(0); // but nothing is recorded
  });

  it('records even when the downstream handler throws, and re-throws', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    const mw = new TelescopeMiddleware();
    await expect(
      mw.handle(stubCtx() as never, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.list({ type: 'request' })).toHaveLength(1);
  });

  it('auto-captures an exception entry on a throwing handler with request context', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    const mw = new TelescopeMiddleware();
    await expect(
      mw.handle(
        {
          request: { method: () => 'POST', url: () => '/orders?token=x' },
          response: { statusCode: 500 },
        } as never,
        async () => {
          throw new TypeError('handler failed');
        },
      ),
    ).rejects.toThrow('handler failed');

    const exceptions = await store.list({ type: 'exception' });
    expect(exceptions).toHaveLength(1);
    const content = exceptions[0]?.content as {
      name: string;
      message: string;
      method: string | null;
      url: string | null;
    };
    expect(content.name).toBe('TypeError');
    expect(content.message).toBe('handler failed');
    expect(content.method).toBe('POST');
    expect(content.url).toBe('/orders');
    expect(exceptions[0]?.familyHash).not.toBeNull();
  });
});

describe('context accessor integration', () => {
  const KEY = Symbol.for('@agora/context:accessor');
  afterEach(() => delete (globalThis as Record<symbol, unknown>)[KEY]);

  it('resolves the ambient traceId from @adonis-agora/context when present', async () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      traceId: () => 'ctx-trace',
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    };
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx(), Date.now());
    const entry = (await store.list())[0];
    expect(entry?.traceId).toBe('ctx-trace');
    expect((entry?.content as { traceId: string | null }).traceId).toBe('ctx-trace');
  });
});
