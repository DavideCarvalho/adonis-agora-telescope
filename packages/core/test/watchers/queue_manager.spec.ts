import { describe, expect, it } from 'vitest';
import type {
  QueueAdapterLike,
  QueueLike,
  QueueManager,
} from '../../src/watchers/queue_manager.js';
import { QueueManagerDriver } from '../../src/watchers/queue_manager.js';

function fakeAdapter(overrides: Partial<QueueAdapterLike> = {}): QueueAdapterLike {
  return {
    getJob: async () => null,
    ...overrides,
  };
}

function fakeQueueService(adapter: QueueAdapterLike | null): QueueLike {
  return { use: () => adapter as QueueAdapterLike };
}

describe('QueueManagerDriver — configuration', () => {
  it('is not configured when the queue service is null (@adonisjs/queue absent)', () => {
    const driver = new QueueManagerDriver(null, { queues: ['default'] });
    expect(driver.configured).toBe(false);
    expect(driver.capabilities).toEqual([]);
  });

  it('degrades to configured:false when `.use()` throws', () => {
    const driver = new QueueManagerDriver({ use: () => throwing() }, { queues: ['default'] });
    expect(driver.configured).toBe(false);
  });

  it('falls back to treating the service itself as the adapter when it has no `.use`', () => {
    const adapter = fakeAdapter();
    const driver = new QueueManagerDriver(adapter as unknown as QueueLike, { queues: ['default'] });
    expect(driver.configured).toBe(true);
  });
});

describe('QueueManagerDriver — capabilities are derived, not guessed', () => {
  it('advertises no actions when the adapter exposes neither retryJob nor push/pushOn', async () => {
    const driver = new QueueManagerDriver(fakeQueueService(fakeAdapter()), { queues: ['default'] });
    expect(driver.capabilities).toEqual([]);
  });

  it('advertises retry only when retryJob is present', () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ retryJob: async () => {} })),
      { queues: ['default'] },
    );
    expect(driver.capabilities).toEqual(['retry']);
  });

  it('advertises enqueue when either push or pushOn is present', () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ pushOn: async () => ({ id: '1' }) })),
      { queues: ['default'] },
    );
    expect(driver.capabilities).toEqual(['enqueue']);
  });

  it('NEVER advertises remove or promote — @boringnode/queue has no such API', () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ retryJob: async () => {}, push: async () => ({}) })),
      { queues: ['default'] },
    );
    expect(driver.capabilities).not.toContain('remove');
    expect(driver.capabilities).not.toContain('promote');
    const asManager: QueueManager = driver;
    expect(asManager.remove).toBeUndefined();
    expect(asManager.promote).toBeUndefined();
    expect(asManager.listJobs).toBeUndefined();
  });
});

describe('QueueManagerDriver — listQueues', () => {
  it('reports a pending count from sizeOf and null for every other (unsupported) state', async () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ sizeOf: async (queue) => (queue === 'emails' ? 3 : 0) })),
      { queues: ['emails', 'reports'] },
    );
    const queues = await driver.listQueues();
    expect(queues).toEqual([
      {
        driver: 'boringnode',
        queue: 'emails',
        counts: { pending: 3, active: null, delayed: null, failed: null, completed: null },
        actions: [],
      },
      {
        driver: 'boringnode',
        queue: 'reports',
        counts: { pending: 0, active: null, delayed: null, failed: null, completed: null },
        actions: [],
      },
    ]);
  });

  it('reports all-null counts when the adapter has no sizeOf', async () => {
    const driver = new QueueManagerDriver(fakeQueueService(fakeAdapter()), { queues: ['x'] });
    const [summary] = await driver.listQueues();
    expect(summary?.counts).toEqual({
      pending: null,
      active: null,
      delayed: null,
      failed: null,
      completed: null,
    });
  });
});

describe('QueueManagerDriver — getJob', () => {
  it('maps a raw job record defensively, tolerating missing fields', async () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(
        fakeAdapter({
          getJob: async (id) =>
            id === '42'
              ? { id: 42, name: 'SendWelcomeEmail', status: 'failed', payload: { to: 'a@b.com' } }
              : null,
        }),
      ),
      { queues: ['emails'] },
    );
    const job = await driver.getJob('emails', '42');
    expect(job).toMatchObject({
      id: '42',
      name: 'SendWelcomeEmail',
      state: 'failed',
      payload: { to: 'a@b.com' },
    });
  });

  it('returns null for an unknown job id', async () => {
    const driver = new QueueManagerDriver(fakeQueueService(fakeAdapter()), { queues: ['x'] });
    expect(await driver.getJob('x', 'missing')).toBeNull();
  });
});

describe('QueueManagerDriver — retry/enqueue', () => {
  it('retry() calls retryJob(id, queue) and throws a clear error when unsupported', async () => {
    const calls: unknown[] = [];
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ retryJob: async (...args) => void calls.push(args) })),
      { queues: ['x'] },
    );
    await driver.retry('x', 'job-1');
    expect(calls).toEqual([['job-1', 'x']]);

    const unsupported = new QueueManagerDriver(fakeQueueService(fakeAdapter()), { queues: ['x'] });
    await expect(unsupported.retry('x', 'job-1')).rejects.toThrow(/does not support/);
  });

  it('enqueue() prefers pushOn(queue, payload, opts) when available', async () => {
    const calls: unknown[] = [];
    const driver = new QueueManagerDriver(
      fakeQueueService(
        fakeAdapter({
          pushOn: async (...args) => {
            calls.push(args);
            return { id: 'job-9' };
          },
        }),
      ),
      { queues: ['x'] },
    );
    const result = await driver.enqueue('x', { hello: 'world' }, { name: 'Greet' });
    expect(result).toEqual({ id: 'job-9' });
    expect(calls).toEqual([['x', { hello: 'world' }, { name: 'Greet' }]]);
  });

  it('enqueue() falls back to push(payload, {queue}) when pushOn is absent', async () => {
    const driver = new QueueManagerDriver(
      fakeQueueService(fakeAdapter({ push: async () => 'job-7' })),
      { queues: ['x'] },
    );
    expect(await driver.enqueue('x', { a: 1 })).toEqual({ id: 'job-7' });
  });

  it('enqueue() throws when neither push nor pushOn is available', async () => {
    const driver = new QueueManagerDriver(fakeQueueService(fakeAdapter()), { queues: ['x'] });
    await expect(driver.enqueue('x', {})).rejects.toThrow(/does not support/);
  });
});

function throwing(): never {
  throw new Error('boom');
}
