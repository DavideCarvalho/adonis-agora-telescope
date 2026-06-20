import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/define_config.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import type { ExtensionContext, TelescopeExtension } from '../../src/extension/types.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { ExtensionApi } from '../../src/ui/extension_api.js';
import { RecordingResponse, makeRequest } from '../../src/ui/http.js';

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
