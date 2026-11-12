import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/define_config.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import type { ExtensionContext, TelescopeExtension } from '../../src/extension/types.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { ExtensionApi } from '../../src/ui/extension_api.js';
import { makeRequest, RecordingResponse } from '../../src/ui/http.js';

function setup() {
  const store = new InMemoryTelescopeStore();
  const ctx: ExtensionContext = {
    store,
    container: { make: async () => undefined as never },
    config: resolveConfig({}),
  };
  const ext: TelescopeExtension = {
    name: 'durable',
    entryTypes: () => [{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }],
    dashboards: () => [{ id: 'durable.runs', label: 'Runs', panels: [] }],
    dataProviders: () => [
      { name: 'durable.state', resolve: async (q) => ({ value: Number(q?.n ?? 0) }) },
      {
        name: 'durable.boom',
        resolve: async () => {
          throw new Error('kaboom');
        },
      },
    ],
  };
  const api = new ExtensionApi(new ExtensionRegistry([ext], ctx), ctx);
  return { api };
}

function http(qs: Record<string, unknown> = {}) {
  return { request: makeRequest('GET', qs), response: new RecordingResponse() };
}

describe('ExtensionApi.meta', () => {
  it('returns contributed entry types + dashboards', () => {
    const { api } = setup();
    const ctx = http();
    api.meta(ctx);
    expect(ctx.response.statusCode).toBe(200);
    const body = ctx.response.body as { data: { entryTypes: unknown[]; dashboards: unknown[] } };
    expect(body.data.entryTypes).toHaveLength(1);
    expect(body.data.dashboards).toHaveLength(1);
  });
});

describe('ExtensionApi.data', () => {
  it('resolves a provider, passing the request query through', async () => {
    const { api } = setup();
    const ctx = http({ n: '7' });
    await api.data(ctx, 'durable', 'durable.state');
    expect(ctx.response.statusCode).toBe(200);
    expect((ctx.response.body as { data: { value: number } }).data.value).toBe(7);
  });

  it('404s when the :ext namespace does not own the provider', async () => {
    const { api } = setup();
    const ctx = http();
    await api.data(ctx, 'other', 'durable.state');
    expect(ctx.response.statusCode).toBe(404);
  });

  it('404s for an unknown provider', async () => {
    const { api } = setup();
    const ctx = http();
    await api.data(ctx, 'durable', 'durable.missing');
    expect(ctx.response.statusCode).toBe(404);
  });

  it('500s (not throws) when a provider rejects', async () => {
    const { api } = setup();
    const ctx = http();
    await api.data(ctx, 'durable', 'durable.boom');
    expect(ctx.response.statusCode).toBe(500);
    expect((ctx.response.body as { error: string }).error).toContain('kaboom');
  });
});

describe('ExtensionApi.action', () => {
  it('meta lists the actions without their run', () => {
    const { api } = actionSetup();
    const ctx = { request: makeRequest('GET'), response: new RecordingResponse() };
    api.meta(ctx);
    const body = ctx.response.body as { data: { actions: unknown[] } };
    expect(body.data.actions).toEqual([
      {
        name: 'resilience.reset-circuit',
        label: 'Reset',
        confirm: 'Reset circuit {key}?',
        destructive: true,
      },
      { name: 'resilience.boom' },
    ]);
  });

  function actionSetup() {
    const store = new InMemoryTelescopeStore();
    const ctx: ExtensionContext = {
      store,
      container: { make: async () => undefined as never },
      config: resolveConfig({}),
    };
    const seen: Array<{ input: Record<string, unknown>; caller: string }> = [];
    const ext: TelescopeExtension = {
      name: 'resilience',
      actions: () => [
        {
          name: 'resilience.reset-circuit',
          label: 'Reset',
          confirm: 'Reset circuit {key}?',
          destructive: true,
          run: async (input, actionCtx) => {
            seen.push({ input, caller: actionCtx.actor });
            return { status: 'closed' };
          },
        },
        {
          name: 'resilience.boom',
          run: async () => {
            throw new Error('store down');
          },
        },
      ],
    };
    const other: TelescopeExtension = { name: 'payments' };
    const audit: unknown[] = [];
    const api = new ExtensionApi(new ExtensionRegistry([ext, other], ctx), ctx, (r) => {
      audit.push(r);
    });
    return { api, seen, audit };
  }

  const http = () => ({ request: makeRequest('POST'), response: new RecordingResponse() });

  it('runs a confirmed action, passes input + caller, and audits it', async () => {
    const { api, seen, audit } = actionSetup();
    const ctx = http();
    await api.action(
      ctx,
      'resilience',
      'resilience.reset-circuit',
      { confirmed: true, input: { key: 'stripe' } },
      { id: 'user:1' },
    );
    expect(ctx.response.statusCode).toBe(200);
    expect(ctx.response.body).toEqual({ data: { status: 'closed' } });
    expect(seen).toEqual([{ input: { key: 'stripe' }, caller: 'user:1' }]);
    expect(audit).toMatchObject([
      { ext: 'resilience', action: 'resilience.reset-circuit', caller: 'user:1', ok: true },
    ]);
  });

  it('refuses without confirmed: true (400) and runs nothing', async () => {
    const { api, seen, audit } = actionSetup();
    const ctx = http();
    await api.action(ctx, 'resilience', 'resilience.reset-circuit', { input: {} }, { id: 'x' });
    expect(ctx.response.statusCode).toBe(400);
    expect(seen).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('404s an unknown action or one addressed under another extension', async () => {
    const { api } = actionSetup();
    const a = http();
    await api.action(a, 'resilience', 'resilience.nope', { confirmed: true }, { id: 'x' });
    expect(a.response.statusCode).toBe(404);
    const b = http();
    await api.action(b, 'payments', 'resilience.reset-circuit', { confirmed: true }, { id: 'x' });
    expect(b.response.statusCode).toBe(404);
  });

  it('a throwing action answers 500 with its message and is audited as failed', async () => {
    const { api, audit } = actionSetup();
    const ctx = http();
    await api.action(ctx, 'resilience', 'resilience.boom', { confirmed: true }, { id: 'x' });
    expect(ctx.response.statusCode).toBe(500);
    expect(ctx.response.body).toEqual({ error: 'store down' });
    expect(audit).toMatchObject([{ ok: false, error: 'store down' }]);
  });
});
