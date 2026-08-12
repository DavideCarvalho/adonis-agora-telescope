import { describe, expect, it } from 'vitest';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { type RetentionInfo, TelescopeApi } from '../../src/ui/api.js';
import { RecordingResponse, makeRequest } from '../../src/ui/http.js';

function ctx() {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', {}), response: res }, res };
}

describe('TelescopeApi.retention', () => {
  it('defaults to disabled pruning and no sampled types when unconfigured', async () => {
    const store = new InMemoryTelescopeStore();
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.retention(c);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: RetentionInfo };
    expect(body.data).toEqual({
      enabled: false,
      afterMs: 0,
      keepLast: null,
      intervalMs: 0,
      sampling: [],
    });
  });

  it('echoes the resolved pruner config and only the sub-100% sampling rates', async () => {
    const store = new InMemoryTelescopeStore();
    const api = new TelescopeApi(
      new TelescopeService(store),
      {},
      undefined,
      {},
      {
        prune: { enabled: true, afterMs: 86_400_000, keepLast: 500, intervalMs: 60_000 },
        sampling: {
          log: 0.25,
          request: 1,
          query: { rate: 0.5, keepErrors: true },
        },
      },
    );
    const { ctx: c, res } = ctx();
    await api.retention(c);
    const body = res.body as { data: RetentionInfo };
    expect(body.data.enabled).toBe(true);
    expect(body.data.afterMs).toBe(86_400_000);
    expect(body.data.keepLast).toBe(500);
    expect(body.data.intervalMs).toBe(60_000);
    expect(body.data.sampling).toEqual(
      expect.arrayContaining([
        { type: 'log', rate: 0.25 },
        { type: 'query', rate: 0.5 },
      ]),
    );
    expect(body.data.sampling).toHaveLength(2);
  });
});
