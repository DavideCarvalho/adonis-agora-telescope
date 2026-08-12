import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/profiling/define_config.js';
import { ProfilerService } from '../../src/profiling/profiler_service.js';
import type { CpuProfileContent } from '../../src/profiling/types.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { RecordingResponse, type UiHttpContext, makeRequest } from '../../src/ui/http.js';
import { ProfilesApi } from '../../src/ui/profiles_api.js';

function ctx(qs: Record<string, unknown> = {}): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', qs), response: res }, res };
}

async function seedProfile(store: InMemoryTelescopeStore): Promise<string> {
  const content: CpuProfileContent = {
    durationMs: 12,
    sampleCount: 3,
    reason: 'manual',
    label: 'GET /users/:id',
    tree: { name: '(root)', file: '', selfMs: 0, totalMs: 12, totalSamples: 3, children: [] },
    hot: [],
  };
  const entry = await store.record({
    type: 'cpu_profile',
    content,
    familyHash: 'GET /users/:id',
    durationMs: 12,
    origin: 'manual',
  });
  return entry.id;
}

describe('ProfilesApi', () => {
  let store: InMemoryTelescopeStore;
  let service: TelescopeService;

  beforeEach(() => {
    store = new InMemoryTelescopeStore();
    service = new TelescopeService(store);
  });

  it('every route answers 404 when profiling is not installed (profiler is null)', async () => {
    const api = new ProfilesApi(service, null);
    expect(api.isConfigured()).toBe(false);

    const status = ctx();
    api.status(status.ctx);
    expect(status.res.statusCode).toBe(404);

    const list = ctx();
    await api.list(list.ctx);
    expect(list.res.statusCode).toBe(404);

    const show = ctx();
    await api.show(show.ctx, 'x');
    expect(show.res.statusCode).toBe(404);

    const arm = ctx();
    api.arm(arm.ctx, { count: 1 });
    expect(arm.res.statusCode).toBe(404);
  });

  it('status() reflects the wired ProfilerService', () => {
    const profiler = new ProfilerService(resolveConfig({ enabled: true, sampleRate: 0.1 }));
    const api = new ProfilesApi(service, profiler);
    expect(api.isConfigured()).toBe(true);
    const { ctx: c, res } = ctx();
    api.status(c);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { enabled: boolean; sampleRate: number } }).data).toMatchObject({
      enabled: true,
      sampleRate: 0.1,
    });
  });

  it('list() returns captured profiles newest-first without the frame tree', async () => {
    await seedProfile(store);
    const profiler = new ProfilerService(resolveConfig({ enabled: true }));
    const api = new ProfilesApi(service, profiler);
    const { ctx: c, res } = ctx();
    await api.list(c);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Array<{ id: string; type: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.type).toBe('cpu_profile');
    expect((body.data[0] as unknown as { content?: unknown }).content).toBeUndefined();
  });

  it('show() returns the full entry (with tree/hot) or 404', async () => {
    const id = await seedProfile(store);
    const profiler = new ProfilerService(resolveConfig({ enabled: true }));
    const api = new ProfilesApi(service, profiler);

    const found = ctx();
    await api.show(found.ctx, id);
    expect(found.res.statusCode).toBe(200);
    const data = (found.res.body as { data: { content: CpuProfileContent } }).data;
    expect(data.content.tree.name).toBe('(root)');

    const missing = ctx();
    await api.show(missing.ctx, 'nope');
    expect(missing.res.statusCode).toBe(404);
  });

  it('show() 404s for an entry that is not a cpu_profile', async () => {
    const other = await store.record({ type: 'request', content: {}, origin: 'manual' });
    const profiler = new ProfilerService(resolveConfig({ enabled: true }));
    const api = new ProfilesApi(service, profiler);
    const { ctx: c, res } = ctx();
    await api.show(c, other.id);
    expect(res.statusCode).toBe(404);
  });

  it('arm() 400s when profiling is disabled, else arms and returns pendingManual', () => {
    const disabled = new ProfilesApi(
      service,
      new ProfilerService(resolveConfig({ enabled: false })),
    );
    const off = ctx();
    disabled.arm(off.ctx, { count: 1 });
    expect(off.res.statusCode).toBe(400);

    const enabled = new ProfilesApi(service, new ProfilerService(resolveConfig({ enabled: true })));
    const on = ctx();
    enabled.arm(on.ctx, { count: 2, label: 'GET /x' });
    expect(on.res.statusCode).toBe(200);
    expect((on.res.body as { data: { pendingManual: number } }).data.pendingManual).toBe(2);
  });

  it('arm() 400s on a non-positive count', () => {
    const api = new ProfilesApi(service, new ProfilerService(resolveConfig({ enabled: true })));
    const { ctx: c, res } = ctx();
    api.arm(c, { count: 0 });
    expect(res.statusCode).toBe(400);
  });
});
