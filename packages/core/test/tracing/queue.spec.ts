import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Job, Locator, QueueManager, Worker } from '@boringnode/queue';
import { KnexQueueSchemaService, knex } from '@boringnode/queue/drivers/knex_adapter';
import Knex from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTraceId } from '../../src/context_accessor.js';
import { buildWaterfall } from '../../src/metrics/waterfall.js';
import {
  registerEnabledWatchers,
  resetTelescopeRuntime,
  setTelescopeRuntime,
} from '../../src/registry.js';
import { resolvePropagation } from '../../src/tracing/config.js';
import { installPropagation } from '../../src/tracing/index.js';
import { QueueWatcher } from '../../src/watchers/queue_watcher.js';
import {
  AppTaggingStore,
  contentOf,
  type RunningApp,
  requestsTo,
  settle,
  startApp,
} from './two_apps.js';

/**
 * A real `@boringnode/queue` (the engine of `@adonisjs/queue`): a request in `shop` dispatches a
 * job, the job is saved to SQLite, and a worker picks it up later, outside any request. The job
 * runs in the request's trace.
 */

const seen: Array<{ traceId: string | null }> = [];

class ChargeJob extends Job<{ order: number }> {
  static override options = { name: 'ChargeJob', queue: 'default' };
  override async execute() {
    seen.push({ traceId: currentTraceId() });
  }
}

let dir: string;
let db: ReturnType<typeof Knex>;
let store: AppTaggingStore;
let shop: RunningApp;
let stop: () => void;
const watcher = new QueueWatcher();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telescope-queue-'));
  db = Knex({
    client: 'better-sqlite3',
    connection: { filename: join(dir, 'queue.db') },
    useNullAsDefault: true,
  });
  const schema = new KnexQueueSchemaService(db);
  await schema.createJobsTable();
  await schema.createSchedulesTable();
  Locator.register('ChargeJob', ChargeJob as never);
  await QueueManager.init({ default: 'sqlite', adapters: { sqlite: knex(db) } } as never);

  store = new AppTaggingStore();
  resetTelescopeRuntime();
  setTelescopeRuntime(store, true);
  registerEnabledWatchers(['request', 'queue']);
  watcher.start();
  stop = installPropagation(resolvePropagation({ targets: [] }), true);

  shop = await startApp('shop', {
    '/order': async () => {
      await ChargeJob.dispatch({ order: 1 });
      return { ok: true };
    },
  });
});

afterAll(async () => {
  stop();
  watcher.stop();
  await shop.close();
  await QueueManager.destroy();
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
  resetTelescopeRuntime();
});

describe('queue jobs carry the trace', () => {
  it('a job dispatched in a request runs in that request’s trace, on a worker', async () => {
    await fetch(`${shop.url}/order`);
    await settle();
    const [order] = await requestsTo(store, '/order');
    const traceId = order?.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    // The saved job carries a W3C trace context naming the request's span.
    const row = (await db('queue_jobs').first()) as { data: string } | undefined;
    const saved = JSON.parse(row?.data ?? '{}') as { traceContext?: Record<string, string> };
    const spanId = contentOf(order).spanId;
    expect(saved.traceContext?.traceparent).toBe(`00-${traceId}-${spanId}-01`);

    // A worker, outside any request, runs it.
    const worker = new Worker({
      default: 'sqlite',
      adapters: { sqlite: knex(db) },
      worker: { idleDelay: '10ms', pollingInterval: '10ms' },
    } as never);
    const running = worker.start(['default']);
    for (let i = 0; i < 200 && seen.length === 0; i++) await settle();
    await worker.stop?.();
    await running;
    await settle();

    expect(seen).toEqual([{ traceId }]);
    const job = (await store.list({})).find((e) => e.type === 'job');
    expect(job?.traceId).toBe(traceId);
    expect(contentOf(job).parentSpanId).toBe(spanId);

    // In the waterfall the job hangs under the request that dispatched it.
    const waterfall = buildWaterfall(await store.list({ traceId: traceId as string }));
    expect(waterfall?.spans).toHaveLength(1);
    expect(waterfall?.spans[0]?.children.map((c) => c.type)).toContain('job');
  });

  it('keeps a trace context the job already carries', async () => {
    const { injectIntoJobs } = await import('../../src/tracing/queue.js');
    const { newTraceScope, runInTraceScope } = await import('../../src/tracing/scope.js');
    const own = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    const jobs = [{ traceContext: { traceparent: own } }, {}] as Array<{
      traceContext?: Record<string, string>;
    }>;
    runInTraceScope(newTraceScope(), () => injectIntoJobs({ jobs }));
    expect(jobs[0]?.traceContext?.traceparent).toBe(own);
    expect(jobs[1]?.traceContext?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
