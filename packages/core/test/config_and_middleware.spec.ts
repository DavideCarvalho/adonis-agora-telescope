import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/define_config.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';
import {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopeRuntime,
} from '../src/registry.js';
import { type HttpContextLike, recordRequest } from '../src/request_watcher.js';
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
    expect(store.list({ type: 'request' })).toHaveLength(1);
  });

  it('does not record when the request watcher is disabled', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, false);
    const mw = new TelescopeMiddleware();
    await mw.handle(stubCtx() as never, async () => {});
    expect(store.count()).toBe(0);
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
    expect(store.list({ type: 'request' })).toHaveLength(1);
  });
});

describe('context accessor integration', () => {
  const KEY = Symbol.for('@agora/context:accessor');
  afterEach(() => delete (globalThis as Record<symbol, unknown>)[KEY]);

  it('resolves the ambient traceId from @agora/context when present', () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      traceId: () => 'ctx-trace',
      tenantId: () => undefined,
      userRef: () => undefined,
      get: () => undefined,
    };
    const store = new InMemoryTelescopeStore();
    recordRequest(store, stubCtx(), Date.now());
    const entry = store.list()[0];
    expect(entry?.traceId).toBe('ctx-trace');
    expect((entry?.content as { traceId: string | null }).traceId).toBe('ctx-trace');
  });
});
