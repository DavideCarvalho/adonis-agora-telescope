/**
 * The redis and bullmq transports against a real Redis (CI runs one; locally set
 * TELESCOPE_TEST_REDIS_URL=redis://127.0.0.1:6379 to run these).
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  type ControlPlaneChannel,
  createIngestHandler,
  InMemoryTelescopeStore,
  RemoteTelescopeStore,
  sharedSecretVerifier,
  type TelescopeTransport,
  transports,
} from '../../src/index.js';

const url = process.env.TELESCOPE_TEST_REDIS_URL;
const verifyTenant = sharedSecretVerifier({
  partitions: { shop: { secret: 'shop-secret', environment: 'ci' } },
});

const clients: Redis[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const client of clients.splice(0)) client.disconnect();
});

function client(): Redis {
  const redis = new Redis(url as string, { maxRetriesPerRequest: null });
  clients.push(redis);
  return redis;
}

/** Send two entries through `transport`, consume them on the control plane, read the store. */
async function roundTrip(transport: TelescopeTransport) {
  const store = new InMemoryTelescopeStore();
  const handler = createIngestHandler({ verifyTenant, store: () => store });
  const consumer = (await transport.controlPlane({})) as ControlPlaneChannel;
  closers.push(() => consumer.close());
  await consumer.start((raw) => handler.message(raw));

  const sender = new RemoteTelescopeStore({
    channel: transport.tenant({}),
    partition: 'shop',
    token: 'shop-secret',
    buffer: { flushIntervalMs: 60_000 },
  });
  closers.push(() => sender.close());
  const createdAt = new Date(Date.now() - 60_000);
  await sender.record({ type: 'log', content: { m: 'a' }, tags: [], createdAt });
  await sender.record({ type: 'log', content: { m: 'b' }, tags: [] });
  await sender.flush();
  expect(sender.stats()).toMatchObject({ sent: 2, buffered: 0 });

  await vi.waitFor(async () => expect(await store.count()).toBe(2), { timeout: 10_000 });
  const rows = await store.list();
  for (const row of rows) expect(row.tags).toEqual(['app:shop', 'env:ci']);
  expect(rows.some((r) => r.createdAt.getTime() === createdAt.getTime())).toBe(true);
  return { store, handler };
}

describe.skipIf(!url)('transports against a real Redis', () => {
  it('redis: a stream through a consumer group, poison messages to the dead stream', async () => {
    const prefix = `telescope-test-${randomUUID()}`;
    const redis = client();
    const transport = transports.redis({ client: redis, prefix, pollIntervalMs: 50 });
    expect(await transport.ping({})).toMatch(/Redis answers/);
    await roundTrip(transport);

    // A message with a bad token lands in <prefix>:ingest:dead, and leaves nothing pending.
    await redis.xadd(
      `${prefix}:ingest`,
      '*',
      'm',
      JSON.stringify({ v: 1, id: 'x', app: 'shop', token: 'nope', sentAt: '', batch: {} }),
    );
    await vi.waitFor(async () => expect(await redis.xlen(`${prefix}:ingest:dead`)).toBe(1), {
      timeout: 10_000,
    });
    const [, , , , pending] = (await redis.xpending(`${prefix}:ingest`, 'telescope')) as unknown[];
    expect(pending ?? null).toBeNull();
    await redis.del(`${prefix}:ingest`, `${prefix}:ingest:dead`);
  });

  it('bullmq: one job per batch, a refused one stays in the failed set', async () => {
    const prefix = `telescope-test-${randomUUID()}`;
    const connection = client();
    const real = transports.bullmq({ connection, prefix });
    expect(await real.ping({})).toMatch(/BullMQ/);
    await roundTrip(real);

    const { Queue } = await import('bullmq');
    const queue = new Queue('telescope-ingest', { connection, prefix });
    closers.push(() => queue.close());
    await queue.add('telescope.ingest', { m: 'not json' }, { attempts: 5 });
    await vi.waitFor(async () => expect(await queue.getFailedCount()).toBe(1), { timeout: 10_000 });
    const [failed] = await queue.getFailed();
    // Dead on the first attempt: never retried.
    expect(failed?.attemptsMade).toBe(1);

    // A refused token: failed at once, and the failed job keeps no token.
    await queue.add(
      'telescope.ingest',
      {
        m: JSON.stringify({
          v: 1,
          id: 'y',
          app: 'shop',
          token: 'leaked-secret',
          sentAt: '',
          batch: {},
        }),
      },
      { attempts: 5 },
    );
    await vi.waitFor(async () => expect(await queue.getFailedCount()).toBe(2), { timeout: 10_000 });
    const all = await queue.getFailed();
    expect(JSON.stringify(all.map((j) => j.data))).not.toContain('leaked-secret');
    await queue.obliterate({ force: true });
  });
});
