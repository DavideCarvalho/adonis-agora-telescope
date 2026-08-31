import { beforeEach, describe, expect, it } from 'vitest';
import type { RecordInput } from '../../src/entry.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { TelescopeApi } from '../../src/ui/api.js';
import { resolveConfig } from '../../src/ui/define_config.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';
import type { ReplayTransport } from '../../src/ui/request_replay.js';

function ctx(): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('POST'), response: res }, res };
}

async function seedRequest(store: InMemoryTelescopeStore): Promise<string> {
  const input: RecordInput = {
    type: 'request',
    content: { method: 'GET', url: '/users', status: 200, durationMs: 5, traceId: null },
    tags: ['method:GET', 'status:200'],
    familyHash: 'GET /users',
    origin: 'http',
  };
  return (await store.record(input)).id;
}

function okTransport(): ReplayTransport {
  return async () => ({ status: 201, text: async () => 'replayed' });
}

describe('TelescopeApi.replayRequest', () => {
  let store: InMemoryTelescopeStore;
  let service: TelescopeService;

  beforeEach(() => {
    store = new InMemoryTelescopeStore();
    service = new TelescopeService(store);
  });

  it('answers 403 when replay is disabled (the safe default)', async () => {
    const id = await seedRequest(store);
    const api = new TelescopeApi(service); // no replay options → disabled
    const { ctx: c, res } = ctx();
    await api.replayRequest(c, id);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/disabled/i);
  });

  it('does not issue any call when disabled', async () => {
    const id = await seedRequest(store);
    let called = false;
    const transport: ReplayTransport = async () => {
      called = true;
      return { status: 200, text: async () => '' };
    };
    const api = new TelescopeApi(service, {}, { enabled: false, transport });
    const { ctx: c } = ctx();
    await api.replayRequest(c, id);
    expect(called).toBe(false);
  });

  it('answers 404 for an unknown id', async () => {
    const api = new TelescopeApi(service, {}, { enabled: true, transport: okTransport() });
    const { ctx: c, res } = ctx();
    await api.replayRequest(c, 'nope');
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 when the entry is not a request entry', async () => {
    const diagId = (
      await store.record({
        type: 'diagnostic',
        content: { lib: 'billing', event: 'invoice-paid' },
        origin: 'manual',
      })
    ).id;
    const api = new TelescopeApi(service, {}, { enabled: true, transport: okTransport() });
    const { ctx: c, res } = ctx();
    await api.replayRequest(c, diagId);
    expect(res.statusCode).toBe(404);
  });

  it('targets the live request port supplied by the provider', async () => {
    const id = await seedRequest(store);
    let targeted = '';
    const transport: ReplayTransport = async (url) => {
      targeted = url;
      return { status: 200, text: async () => 'ok' };
    };
    const api = new TelescopeApi(service, {}, { enabled: true, transport });
    const { ctx: c } = ctx();
    await api.replayRequest(c, id, 4321);
    expect(targeted).toBe('http://127.0.0.1:4321/users');
  });

  it('lets the configured replay.port override the live request port', async () => {
    const id = await seedRequest(store);
    let targeted = '';
    const transport: ReplayTransport = async (url) => {
      targeted = url;
      return { status: 200, text: async () => 'ok' };
    };
    const api = new TelescopeApi(service, {}, { enabled: true, port: 9000, transport });
    const { ctx: c } = ctx();
    await api.replayRequest(c, id, 4321);
    expect(targeted).toBe('http://127.0.0.1:9000/users');
  });

  it('replays against the injected transport and returns the outcome when enabled', async () => {
    const id = await seedRequest(store);
    const api = new TelescopeApi(
      service,
      {},
      { enabled: true, transport: okTransport(), clock: { now: () => 0 } },
    );
    const { ctx: c, res } = ctx();
    await api.replayRequest(c, id);
    expect(res.statusCode).toBe(200);
    const data = (res.body as { data: { status: number; body: string } }).data;
    expect(data.status).toBe(201);
    expect(data.body).toBe('replayed');
  });
});

describe('resolveConfig — replay defaults', () => {
  it('disables replay by default', () => {
    expect(resolveConfig().replay).toEqual({ enabled: false });
  });

  it('passes through enabled + port + timeout when set', () => {
    const resolved = resolveConfig({ replay: { enabled: true, port: 4000, timeoutMs: 5000 } });
    expect(resolved.replay).toEqual({ enabled: true, port: 4000, timeoutMs: 5000 });
  });
});
