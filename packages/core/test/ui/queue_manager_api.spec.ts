import { describe, expect, it } from 'vitest';
import { RecordingResponse, type UiHttpContext, makeRequest } from '../../src/ui/http.js';
import { QueueManagerApi } from '../../src/ui/queue_manager_api.js';
import { QueueManagerDriver } from '../../src/watchers/queue_manager.js';
import type { QueueAdapterLike, QueueLike } from '../../src/watchers/queue_manager.js';

function ctx(): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET'), response: res }, res };
}

function driver(adapter: QueueAdapterLike | null, queues = ['default']): QueueManagerDriver {
  const service: QueueLike = { use: () => adapter as QueueAdapterLike };
  return new QueueManagerDriver(adapter === null ? null : service, { queues });
}

describe('QueueManagerApi', () => {
  it('every route 404s when the manager is not configured', async () => {
    const api = new QueueManagerApi(null);
    expect(api.isConfigured()).toBe(false);

    const list = ctx();
    await api.list(list.ctx, false);
    expect(list.res.statusCode).toBe(404);

    const job = ctx();
    await api.job(job.ctx, 'q', 'id');
    expect(job.res.statusCode).toBe(404);

    const retry = ctx();
    await api.retry(retry.ctx, 'q', 'id');
    expect(retry.res.statusCode).toBe(404);

    const enqueue = ctx();
    await api.enqueue(enqueue.ctx, 'q', { payload: {} });
    expect(enqueue.res.statusCode).toBe(404);
  });

  it('list() returns queues + aggregated capabilities, echoing the mutationsEnabled flag it is given', async () => {
    const manager = driver({ getJob: async () => null, retryJob: async () => {} }, ['a', 'b']);
    const api = new QueueManagerApi(manager);
    const { ctx: c, res } = ctx();
    await api.list(c, true);
    expect(res.statusCode).toBe(200);
    const data = (
      res.body as {
        data: { queues: unknown[]; capabilities: { mutationsEnabled: boolean; actions: string[] } };
      }
    ).data;
    expect(data.queues).toHaveLength(2);
    expect(data.capabilities).toEqual({ mutationsEnabled: true, actions: ['retry'] });
  });

  it('job() proxies getJob and 404s for an unknown job', async () => {
    const manager = driver({
      getJob: async (id) => (id === '1' ? { id: '1', name: 'x' } : null),
    });
    const api = new QueueManagerApi(manager);

    const found = ctx();
    await api.job(found.ctx, 'default', '1');
    expect(found.res.statusCode).toBe(200);

    const missing = ctx();
    await api.job(missing.ctx, 'default', '2');
    expect(missing.res.statusCode).toBe(404);
  });

  it('retry() answers 501 when the driver has no retry capability', async () => {
    const manager = driver({ getJob: async () => null });
    const api = new QueueManagerApi(manager);
    const { ctx: c, res } = ctx();
    await api.retry(c, 'default', '1');
    expect(res.statusCode).toBe(501);
  });

  it('retry() proxies to the driver and reports its ok:true on success', async () => {
    const calls: unknown[] = [];
    const manager = driver({
      getJob: async () => null,
      retryJob: async (...args) => void calls.push(args),
    });
    const api = new QueueManagerApi(manager);
    const { ctx: c, res } = ctx();
    await api.retry(c, 'default', '1');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['1', 'default']]);
  });

  it('enqueue() requires a payload field when supported', async () => {
    const manager = driver({ getJob: async () => null, push: async () => 'job-1' });
    const api = new QueueManagerApi(manager);
    const noPayload = ctx();
    await api.enqueue(noPayload.ctx, 'default', {});
    expect(noPayload.res.statusCode).toBe(400);
  });

  it('enqueue() answers 501 when the adapter supports neither push nor pushOn', async () => {
    const manager = driver({ getJob: async () => null });
    const api = new QueueManagerApi(manager);
    const unsupported = ctx();
    await api.enqueue(unsupported.ctx, 'default', { payload: { x: 1 } });
    expect(unsupported.res.statusCode).toBe(501);
  });

  it('enqueue() proxies to the driver on success', async () => {
    const manager = driver({
      getJob: async () => null,
      pushOn: async () => ({ id: 'job-1' }),
    });
    const api = new QueueManagerApi(manager);
    const { ctx: c, res } = ctx();
    await api.enqueue(c, 'default', { payload: { x: 1 }, name: 'Greet' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { id: string | null } }).data).toEqual({ id: 'job-1' });
  });
});
