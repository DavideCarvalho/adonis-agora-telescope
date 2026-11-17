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

  it('redis: an idle consumer blocks on its own connection and closes at once', async () => {
    const prefix = `telescope-test-${randomUUID()}`;
    const redis = client();
    /** Commands of the kinds a consumer sends, counted by the server over `ms`. */
    async function idleCommands(options: Parameters<typeof transports.redis>[0], ms: number) {
      const consumer = (await transports
        .redis({ client: redis, prefix, ...options })
        .controlPlane({})) as ControlPlaneChannel;
      await consumer.start(async () => ({ kind: 'ok' }));
      // Past the first round (group creation, the take-over of what a previous run left).
      await new Promise((resolve) => setTimeout(resolve, 300));
      await redis.config('RESETSTAT');
      await new Promise((resolve) => setTimeout(resolve, ms));
      const stats = String(await redis.info('commandstats'));
      const started = Date.now();
      await consumer.close();
      const closeMs = Date.now() - started;
      const calls = (name: string) =>
        Number(new RegExp(`cmdstat_${name}:calls=(\\d+)`).exec(stats)?.[1] ?? 0);
      return { xreadgroup: calls('xreadgroup'), xpending: calls('xpending'), closeMs };
    }

    const polling = await idleCommands({ blockMs: 0, pollIntervalMs: 100 }, 2000);
    const blocking = await idleCommands({ blockMs: 1000 }, 2000);
    // Polling: ~20 reads (and an XPENDING each, before); blocking: ~2 reads, no XPENDING.
    expect(polling.xreadgroup).toBeGreaterThanOrEqual(10);
    expect(polling.xpending).toBe(0);
    expect(blocking.xreadgroup).toBeLessThanOrEqual(3);
    expect(blocking.xpending).toBe(0);
    // close() does not wait out the blocked read.
    expect(blocking.closeMs).toBeLessThan(500);

    // A message is read as soon as it lands, not after blockMs.
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({ verifyTenant, store: () => store });
    const transport = transports.redis({ client: redis, prefix, blockMs: 30_000 });
    const consumer = (await transport.controlPlane({})) as ControlPlaneChannel;
    closers.push(() => consumer.close());
    await consumer.start((raw) => handler.message(raw));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sender = new RemoteTelescopeStore({
      channel: transport.tenant({}),
      partition: 'shop',
      token: 'shop-secret',
      buffer: { flushIntervalMs: 60_000 },
    });
    closers.push(() => sender.close());
    await sender.record({ type: 'log', content: { m: 'now' }, tags: [] });
    await sender.flush();
    await vi.waitFor(async () => expect(await store.count()).toBe(1), { timeout: 1000 });
    const started = Date.now();
    await consumer.close();
    expect(Date.now() - started).toBeLessThan(500);
    await redis.del(`${prefix}:ingest`, `${prefix}:ingest:dead`);
  });

  it('redis: one XACK per read, no XDEL, and acked messages trimmed in bulk', async () => {
    const prefix = `telescope-test-${randomUUID()}`;
    const redis = client();
    const stream = `${prefix}:ingest`;
    const consumer = (await transports
      .redis({ client: redis, prefix, trimIntervalMs: 0, readCount: 50 })
      .controlPlane({})) as ControlPlaneChannel;
    let handled = 0;
    await consumer.start(async () => {
      handled += 1;
      return { kind: 'ok' };
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await redis.config('RESETSTAT');
    const pipeline = redis.pipeline();
    for (let i = 0; i < 250; i += 1) pipeline.xadd(stream, '*', 'm', `{"i":${i}}`);
    await pipeline.exec();
    await vi.waitFor(() => expect(handled).toBe(250), { timeout: 10_000 });
    await consumer.close();
    const stats = String(await redis.info('commandstats'));
    const calls = (name: string) =>
      Number(new RegExp(`cmdstat_${name}:calls=(\\d+)`).exec(stats)?.[1] ?? 0);
    expect(calls('xdel')).toBe(0);
    // 250 messages read 50 at a time (or fewer, as they land): one XACK per read.
    expect(calls('xack')).toBeLessThanOrEqual(calls('xreadgroup'));
    expect(calls('xack')).toBeLessThan(250);
    // Nothing pending, and the acked messages trimmed (`~`: whole nodes, so some may remain).
    const [count] = (await redis.xpending(stream, 'telescope')) as [number];
    expect(Number(count)).toBe(0);
    expect(await redis.xlen(stream)).toBeLessThan(250);
    await redis.del(stream);
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
