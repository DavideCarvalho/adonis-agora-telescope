import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bullmqTransport,
  type ControlPlaneChannel,
  createIngestHandler,
  defineConfig,
  InMemoryTelescopeStore,
  type MessageHandler,
  QueueControlPlaneChannel,
  RedisControlPlaneChannel,
  RemoteTelescopeStore,
  resolveConfig,
  resolveTopology,
  sharedSecretVerifier,
  type TelescopeStore,
  type TelescopeTransport,
  transports,
} from '../../src/index.js';
import {
  FakeDurableTransport,
  FakeQueueAdapter,
  FakeRedis,
  fakeBullmq,
} from './transport_fakes.js';

const verifyTenant = sharedSecretVerifier({
  partitions: {
    shop: { secret: 'shop-secret', environment: 'production' },
    billing: 'billing-secret',
  },
});

/** The control plane: the ingest handler over an in-memory store (which can be taken down). */
function controlPlane() {
  const store = new InMemoryTelescopeStore();
  const state = { storeDown: false };
  const failing: TelescopeStore = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'record' && state.storeDown) {
        return async () => {
          throw new Error('store down');
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const refused: string[] = [];
  const handler = createIngestHandler({
    verifyTenant,
    store: () => failing,
    onRefused: (reason) => refused.push(reason),
  });
  return { store, handler, state, refused };
}

const stores: RemoteTelescopeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

function tenant(transport: TelescopeTransport, token = 'shop-secret', partition = 'shop') {
  let now = Date.now();
  const store = new RemoteTelescopeStore({
    channel: transport.tenant({}),
    partition,
    token,
    now: () => now,
    buffer: { flushIntervalMs: 60_000, retry: { baseMs: 1000, maxMs: 8000 } },
  });
  stores.push(store);
  return { store, advance: (ms: number) => (now += ms) };
}

const log = (message: string, extra: Record<string, unknown> = {}) => ({
  type: 'log',
  content: { message },
  tags: ['level:info'],
  ...extra,
});

/** One driver wired to a fake broker shared by both sides. */
interface Kit {
  transport: TelescopeTransport;
  /** Start the control plane's consumer and deliver everything the broker holds. */
  pump(channel: ControlPlaneChannel, handler: MessageHandler): Promise<void>;
  setDown(down: boolean): void;
  deadLetters(): number;
  /** Let time pass so a message left pending can be delivered again. */
  idle?(): void;
}

const kits: Record<string, () => Kit> = {
  queue: () => {
    const adapter = new FakeQueueAdapter();
    return {
      transport: transports.queue({ adapter: () => adapter }),
      async pump(channel, handler) {
        while (await (channel as QueueControlPlaneChannel).once(handler)) {}
      },
      setDown: (down) => {
        adapter.down = down;
      },
      deadLetters: () => adapter.failed.length,
      idle: () => {
        adapter.clockOffset += 120_000;
      },
    };
  },
  bullmq: () => {
    const fake = fakeBullmq();
    let started = false;
    return {
      transport: bullmqTransport({ connection: {} }, async () => fake.module),
      async pump(channel, handler) {
        if (!started) await channel.start(handler);
        started = true;
        await fake.drain();
      },
      setDown: (down) => {
        fake.state.down = down;
      },
      deadLetters: () => fake.jobs.filter((j) => j.state === 'failed').length,
    };
  },
  redis: () => {
    const redis = new FakeRedis();
    return {
      transport: transports.redis({ client: redis }),
      async pump(channel, handler) {
        while (await (channel as RedisControlPlaneChannel).once(handler, { reclaim: true })) {}
      },
      setDown: (down) => {
        redis.down = down;
      },
      deadLetters: () => redis.streams.get('telescope:ingest:dead')?.length ?? 0,
      idle: () => {
        redis.clockOffset += 120_000;
      },
    };
  },
  durable: () => {
    const broker = new FakeDurableTransport();
    let started = false;
    return {
      transport: transports.durable({ transport: async () => broker }),
      async pump(channel, handler) {
        if (!started) await channel.start(handler);
        started = true;
        await broker.deliver();
      },
      setDown: (down) => {
        broker.down = down;
      },
      deadLetters: () =>
        broker.results.filter((r) => (r as { deadLettered?: string }).deadLettered).length,
    };
  },
};

describe.each(Object.keys(kits))('transport %s', (name) => {
  async function setup() {
    const kit = (kits[name] as () => Kit)();
    const cp = controlPlane();
    const channel = (await kit.transport.controlPlane({})) as ControlPlaneChannel;
    const pump = () => kit.pump(channel, (raw) => cp.handler.message(raw));
    return { kit, cp, channel, pump };
  }

  it('delivers entries tagged with the app and environment from the token, keeping createdAt', async () => {
    const { kit, cp, pump } = await setup();
    const { store } = tenant(kit.transport);
    const createdAt = new Date('2026-11-01T10:00:00.000Z');
    const sent = await store.record(log('hello', { createdAt }));
    await store.record(log('world'));
    await store.flush();
    expect(store.stats()).toMatchObject({ buffered: 0, sent: 2, failures: 0 });
    await pump();
    const rows = await cp.store.list();
    expect(rows).toHaveLength(2);
    const hello = rows.find((r) => r.id === `shop:${sent.id}`);
    expect(hello?.createdAt.toISOString()).toBe(createdAt.toISOString());
    for (const row of rows) expect(row.tags).toEqual(['level:info', 'app:shop', 'env:production']);
  });

  it('keeps entries in the local buffer while the broker is down, then sends them', async () => {
    const { kit, cp, pump } = await setup();
    const { store, advance } = tenant(kit.transport);
    kit.setDown(true);
    await store.record(log('a'));
    await store.flush();
    expect(store.stats()).toMatchObject({ buffered: 1, sent: 0, failures: 1 });
    expect(store.stats().lastError).toMatch(/ECONNREFUSED|broker down/);
    kit.setDown(false);
    advance(10_000);
    await store.flush();
    expect(store.stats()).toMatchObject({ buffered: 0, sent: 1, failures: 0 });
    await pump();
    expect(await cp.store.count()).toBe(1);
  });

  it('dead-letters a message whose token the control plane refuses', async () => {
    const { kit, cp, pump } = await setup();
    const { store } = tenant(kit.transport, 'stolen-or-wrong');
    await store.record(log('x'));
    await store.flush();
    await pump();
    expect(await cp.store.count()).toBe(0);
    expect(kit.deadLetters()).toBe(1);
    expect(cp.refused).toContain('refused (401 unauthenticated)');
  });

  it('the app comes from the token, never from what the message claims', async () => {
    const { kit, cp, pump } = await setup();
    // Billing's token, claiming to be shop: refused, nothing is stored as shop.
    const { store } = tenant(kit.transport, 'billing-secret', 'shop');
    await store.record(log('x'));
    await store.flush();
    await pump();
    expect(await cp.store.count()).toBe(0);
    expect(kit.deadLetters()).toBe(1);
    // Billing as itself: tagged billing.
    const billing = tenant(kit.transport, 'billing-secret', 'billing');
    await billing.store.record(log('y', { tags: ['app:shop'] }));
    await billing.store.flush();
    await pump();
    const [row] = await cp.store.list();
    expect(row?.tags).toEqual(['app:billing']);
    expect(row?.id.startsWith('billing:')).toBe(true);
  });

  it('a transient store failure is retried, not dead-lettered', async () => {
    const { kit, cp, pump } = await setup();
    const { store } = tenant(kit.transport);
    await store.record(log('x'));
    await store.flush();
    cp.state.storeDown = true;
    if (name === 'durable') {
      // Durable retries in place (with backoff) until the store is back.
      setTimeout(() => {
        cp.state.storeDown = false;
      }, 50);
      await pump();
    } else {
      await pump();
      expect(await cp.store.count()).toBe(0);
      expect(kit.deadLetters()).toBe(0);
      cp.state.storeDown = false;
      kit.idle?.();
      await pump();
    }
    expect(await cp.store.count()).toBe(1);
    expect(kit.deadLetters()).toBe(0);
  });
});

describe('redis: pending messages', () => {
  it('a message left pending is taken over once idle, and dead-lettered after maxAttempts', async () => {
    const redis = new FakeRedis();
    const transport = transports.redis({ client: redis, claimIdleMs: 1000, maxAttempts: 3 });
    const cp = controlPlane();
    const channel = (await transport.controlPlane({})) as RedisControlPlaneChannel;
    const handler: MessageHandler = (raw) => cp.handler.message(raw);
    const { store } = tenant(transport);
    await store.record(log('x'));
    await store.flush();

    cp.state.storeDown = true;
    await channel.once(handler, { reclaim: true });
    expect(redis.pending('telescope:ingest')).toBe(1);

    // Back up: the next take-over stores it.
    cp.state.storeDown = false;
    redis.clockOffset += 20_000;
    await channel.once(handler, { reclaim: true });
    expect(await cp.store.count()).toBe(1);
    expect(redis.pending('telescope:ingest')).toBe(0);

    // A message that keeps failing goes to the dead stream after 3 deliveries.
    await store.record(log('y'));
    await store.flush();
    cp.state.storeDown = true;
    await channel.once(handler, { reclaim: true });
    for (let i = 0; i < 3; i += 1) {
      redis.clockOffset += 20_000;
      await channel.once(handler, { reclaim: true });
    }
    expect(redis.pending('telescope:ingest')).toBe(0);
    const dead = redis.streams.get('telescope:ingest:dead') ?? [];
    expect(dead).toHaveLength(1);
    expect(dead[0]?.fields).toContain('reason');
    // The dead-letter copy keeps no bearer token.
    expect(dead[0]?.fields.join(' ')).not.toContain('shop-secret');
    expect(dead[0]?.fields.join(' ')).toContain('[redacted]');
  });
});

describe('redis: blocking read', () => {
  function setup(options: Parameters<typeof transports.redis>[0] = {}, redis = new FakeRedis()) {
    const transport = transports.redis({ client: redis, ...options });
    const cp = controlPlane();
    return { redis, transport, cp, handler: ((raw) => cp.handler.message(raw)) as MessageHandler };
  }

  it('an idle consumer waits on the server: one read per blockMs, pending looked at once', async () => {
    const { redis, transport, handler } = setup({ blockMs: 200 });
    const channel = (await transport.controlPlane({})) as ControlPlaneChannel;
    await channel.start(handler);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await channel.close();
    // ~5 reads in a second instead of ~2 per pollIntervalMs (500 ms), plus an XPENDING each.
    expect(redis.count('XREADGROUP')).toBeGreaterThanOrEqual(4);
    expect(redis.count('XREADGROUP')).toBeLessThanOrEqual(6);
    expect(redis.count('XPENDING')).toBe(1);
    expect(redis.duplicates).toEqual([{ open: false }]);
  });

  it('reads a new message as soon as it lands', async () => {
    const { transport, cp, handler } = setup({ blockMs: 60_000 });
    const channel = (await transport.controlPlane({})) as ControlPlaneChannel;
    await channel.start(handler);
    const { store } = tenant(transport);
    await store.record(log('now'));
    await store.flush();
    await vi.waitFor(async () => expect(await cp.store.count()).toBe(1), { timeout: 200 });
    await channel.close();
  });

  it('close() cuts the blocked read short', async () => {
    const { redis, transport, handler } = setup({ blockMs: 60_000 });
    const channel = (await transport.controlPlane({})) as ControlPlaneChannel;
    await channel.start(handler);
    await vi.waitFor(() => expect(redis.count('XREADGROUP')).toBe(1));
    const started = Date.now();
    await channel.close();
    expect(Date.now() - started).toBeLessThan(500);
    expect(redis.duplicates).toEqual([{ open: false }]);
  });

  it('pending messages are looked at every reclaimIntervalMs and after an error', async () => {
    const errors: unknown[] = [];
    const redis = new FakeRedis();
    const channel = new RedisControlPlaneChannel(
      redis,
      { blockMs: 50, reclaimIntervalMs: 60_000, pollIntervalMs: 20 },
      (error) => errors.push(error),
    );
    const cp = controlPlane();
    await channel.start((raw) => cp.handler.message(raw));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(redis.count('XPENDING')).toBe(1);
    redis.down = true;
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    redis.down = false;
    const atRecovery = redis.count('XPENDING');
    // Back up: one take-over, then quiet again until the next interval.
    await vi.waitFor(() => expect(redis.count('XPENDING')).toBe(atRecovery + 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(redis.count('XPENDING')).toBe(atRecovery + 1);
    await channel.close();
  });

  it('polls every pollIntervalMs with blockMs: 0', async () => {
    const { redis, transport, cp, handler } = setup({ blockMs: 0, pollIntervalMs: 20 });
    const channel = (await transport.controlPlane({})) as ControlPlaneChannel;
    await channel.start(handler);
    const { store } = tenant(transport);
    await store.record(log('polled'));
    await store.flush();
    await vi.waitFor(async () => expect(await cp.store.count()).toBe(1));
    await channel.close();
    expect(redis.duplicates).toHaveLength(0);
  });

  it('polls when the client cannot open a connection (a plain `{ call }`)', async () => {
    const redis = new FakeRedis();
    const channel = (await transports
      .redis({ client: { call: redis.call.bind(redis) }, pollIntervalMs: 20 })
      .controlPlane({})) as ControlPlaneChannel;
    await channel.start(async () => ({ kind: 'ok' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await channel.close();
    expect(redis.duplicates).toHaveLength(0);
    expect(redis.count('XREADGROUP')).toBeGreaterThan(3);
    // Still only the first round looks at pending messages.
    expect(redis.count('XPENDING')).toBe(1);
  });

  it('duplicates the ioredis client an @adonisjs/redis connection wraps', async () => {
    const redis = new FakeRedis();
    const adonisConnection = { call: redis.call.bind(redis), ioConnection: redis };
    const channel = (await transports
      .redis({ client: adonisConnection, blockMs: 50 })
      .controlPlane({})) as ControlPlaneChannel;
    await channel.start(async () => ({ kind: 'ok' }));
    await channel.close();
    expect(redis.duplicates).toEqual([{ open: false }]);
  });
});

describe('redis: commands per batch', () => {
  it('one XACK for every message of a read, and no XDEL', async () => {
    const redis = new FakeRedis();
    const transport = transports.redis({ client: redis });
    const cp = controlPlane();
    const channel = (await transport.controlPlane({})) as RedisControlPlaneChannel;
    const { store } = tenant(transport, 'shop-secret', 'shop');
    for (const m of ['a', 'b', 'c']) {
      await store.record(log(m));
      await store.flush();
    }
    await channel.once((raw) => cp.handler.message(raw), { reclaim: false });
    expect(await cp.store.count()).toBe(3);
    expect(redis.acks).toEqual([3]);
    expect(redis.count('XDEL')).toBe(0);
    expect(redis.pending('telescope:ingest')).toBe(0);
  });

  it('trims what every group acked, keeping pending and unread messages', async () => {
    const redis = new FakeRedis();
    const options = { client: redis, trimIntervalMs: 0, claimIdleMs: 1000 };
    const cp = controlPlane();
    const channel = (await transports.redis(options).controlPlane({})) as RedisControlPlaneChannel;
    // A second group on the same stream that has read nothing yet.
    const other = (await transports
      .redis({ ...options, group: 'other' })
      .controlPlane({})) as RedisControlPlaneChannel;
    const { store } = tenant(transports.redis(options));
    const send = async (m: string) => {
      await store.record(log(m));
      await store.flush();
    };
    const handler: MessageHandler = (raw) => cp.handler.message(raw);
    await send('a');
    await send('b');
    await other.once(async () => ({ kind: 'retry', reason: 'not now' }), { reclaim: false });
    // `other` holds a and b pending: nothing is trimmed though `telescope` acked them.
    await channel.once(handler, { reclaim: false });
    expect(redis.streams.get('telescope:ingest')).toHaveLength(2);

    // `other` gets them stored on its take-over: both groups are done, the stream is trimmed.
    redis.clockOffset += 20_000;
    await other.once(async () => ({ kind: 'ok' }), { reclaim: true });
    await send('c');
    cp.state.storeDown = true;
    await channel.once(handler, { reclaim: false });
    // c is pending in `telescope` and unread in `other`: kept, a and b gone.
    const ids = (redis.streams.get('telescope:ingest') ?? []).map((m) => m.id);
    expect(ids).toEqual(['3-0']);
    // The pending one is still taken over and stored.
    cp.state.storeDown = false;
    redis.clockOffset += 20_000;
    await channel.once(handler, { reclaim: true });
    expect(await cp.store.count()).toBe(3);
    expect(redis.pending('telescope:ingest')).toBe(0);
  });

  it('trims at most every trimIntervalMs, and not while idle', async () => {
    const redis = new FakeRedis();
    const channel = (await transports
      .redis({ client: redis, trimIntervalMs: 60_000 })
      .controlPlane({})) as RedisControlPlaneChannel;
    const cp = controlPlane();
    const { store } = tenant(transports.redis({ client: redis }));
    for (let i = 0; i < 5; i += 1) {
      await store.record(log(`m${i}`));
      await store.flush();
      await channel.once((raw) => cp.handler.message(raw), { reclaim: false });
    }
    expect(redis.count('XTRIM')).toBe(0);
    expect(redis.count('XINFO')).toBe(0);
  });

  it('the redis transport sends every 5 s by default; tenant.buffer still wins', () => {
    const tenantOptions = { partition: 'shop', token: 't' };
    const viaRedis = resolveTopology({
      topology: 'tenant',
      tenant: tenantOptions,
      transport: transports.redis(),
    });
    expect(viaRedis.topology === 'tenant' && viaRedis.buffer.flushIntervalMs).toBe(5000);
    const explicit = resolveTopology({
      topology: 'tenant',
      tenant: { ...tenantOptions, buffer: { flushIntervalMs: 1000 } },
      transport: transports.redis(),
    });
    expect(explicit.topology === 'tenant' && explicit.buffer.flushIntervalMs).toBe(1000);
    const viaHttp = resolveTopology({
      topology: 'tenant',
      tenant: { ...tenantOptions, url: 'https://t.test' },
    });
    expect(viaHttp.topology === 'tenant' && viaHttp.buffer.flushIntervalMs).toBe(1000);
  });
});

describe('queue: retries', () => {
  it('a job that keeps failing is failed (dead-lettered) after maxAttempts', async () => {
    const adapter = new FakeQueueAdapter();
    const transport = transports.queue({ adapter: () => adapter, maxAttempts: 2 });
    const cp = controlPlane();
    const channel = (await transport.controlPlane({})) as QueueControlPlaneChannel;
    const { store } = tenant(transport);
    await store.record(log('x'));
    await store.flush();
    cp.state.storeDown = true;
    for (let i = 0; i < 3; i += 1) {
      while (await channel.once((raw) => cp.handler.message(raw))) {}
      adapter.clockOffset += 120_000;
    }
    expect(adapter.failed).toHaveLength(1);
    expect(adapter.failed[0]?.error).toMatch(/^gave up/);
  });
});

describe('ingest: broker messages', () => {
  const envelope = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      id: 'm-1',
      app: 'shop',
      token: 'shop-secret',
      sentAt: new Date().toISOString(),
      batch: {
        version: 1,
        entries: [
          {
            id: 'e-1',
            type: 'log',
            familyHash: null,
            content: {},
            tags: ['app:evil', 'level:info'],
            durationMs: null,
            origin: 'http',
            traceId: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
      ...overrides,
    });

  it('a redelivered message is acknowledged and stored once (<app>:<id>)', async () => {
    const cp = controlPlane();
    expect(await cp.handler.message(envelope())).toEqual({ kind: 'ok' });
    expect(await cp.handler.message(envelope())).toEqual({ kind: 'ok' });
    const rows = await cp.store.list();
    expect(rows).toHaveLength(1);
    // A tag the sender set for the app is dropped: only the token names the app.
    expect(rows[0]?.tags).toEqual(['level:info', 'app:shop', 'env:production']);
  });

  it('poison messages are dead, transient failures retry', async () => {
    const cp = controlPlane();
    expect((await cp.handler.message('not json')).kind).toBe('dead');
    expect((await cp.handler.message(envelope({ v: 2 }))).kind).toBe('dead');
    expect((await cp.handler.message(envelope({ id: '' }))).kind).toBe('dead');
    expect((await cp.handler.message(envelope({ token: undefined }))).kind).toBe('dead');
    expect((await cp.handler.message(envelope({ batch: { entries: 'x' } }))).kind).toBe('dead');
    cp.state.storeDown = true;
    expect((await cp.handler.message(envelope())).kind).toBe('retry');
  });

  it('a message over the size limit is dead', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant,
      store: () => store,
      limits: {
        ...(await import('../../src/index.js')).resolveIngestLimits({ maxBodyBytes: 100 }),
      },
    });
    expect(await handler.message(envelope())).toMatchObject({ kind: 'dead' });
  });

  it('a verifier that is down retries', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: async () => {
        throw new Error('jwks unreachable');
      },
      store: () => store,
    });
    expect((await handler.message(envelope())).kind).toBe('retry');
  });
});

describe('mixed fleet: one control plane, a tenant on HTTP and one on a broker', () => {
  it("both tenants' entries land in the same store, each tagged with its own app", async () => {
    const cp = controlPlane();
    // Tenant 1: HTTP straight into the ingest route's handler.
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const answer = await cp.handler.ingest({
        token: headers.authorization?.replace(/^Bearer /, ''),
        app: headers['x-telescope-app'],
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    const viaHttp = tenant(
      transports.http({ url: 'https://telescope.test', fetch }),
      'billing-secret',
      'billing',
    );
    // Tenant 2: a Redis stream the control plane also consumes.
    const redis = new FakeRedis();
    const viaRedis = transports.redis({ client: redis });
    const shop = tenant(viaRedis);
    const consumer = (await viaRedis.controlPlane({})) as RedisControlPlaneChannel;

    await viaHttp.store.record(log('from billing'));
    await shop.store.record(log('from shop'));
    await viaHttp.store.flush();
    await shop.store.flush();
    while (await consumer.once((raw) => cp.handler.message(raw))) {}

    expect(fetch).toHaveBeenCalledOnce();
    const rows = await cp.store.list();
    expect(rows.map((r) => r.tags.find((t) => t.startsWith('app:'))).sort()).toEqual([
      'app:billing',
      'app:shop',
    ]);
  });
});

describe('transports: config and lazy peers', () => {
  it('http is the default and tenant.url stays the shorthand', () => {
    const resolved = resolveTopology({
      topology: 'tenant',
      tenant: { url: 'https://telescope.test', partition: 'shop', token: 't' },
    });
    expect(resolved.topology === 'tenant' && resolved.transport.driver).toBe('http');
    expect(resolved.topology === 'tenant' && resolved.transport.describe()).toBe(
      'http https://telescope.test/_telescope/v1',
    );
  });

  it('a tenant with a transport needs no url, and refuses both', () => {
    const resolved = resolveTopology({
      topology: 'tenant',
      transport: transports.redis(),
      tenant: { partition: 'shop', token: 't' },
    });
    expect(resolved.topology === 'tenant' && resolved.transport.driver).toBe('redis');
    expect(() =>
      defineConfig({
        topology: 'tenant',
        transport: transports.redis(),
        tenant: { url: 'https://x.test', partition: 'shop', token: 't' },
      }),
    ).toThrow(/set the server in one place/);
    expect(() =>
      resolveConfig({ topology: 'tenant', tenant: { partition: 'shop', token: 't' } }),
    ).toThrow(/needs tenant\.url\./);
  });

  it('a control plane keeps HTTP and also consumes a broker transport', () => {
    const http = resolveTopology({ topology: 'control-plane', verifyTenant });
    expect(http.topology === 'control-plane' && http.transport).toBeNull();
    const withHttp = resolveTopology({
      topology: 'control-plane',
      verifyTenant,
      transport: transports.http({ url: 'https://telescope.test' }),
    });
    expect(withHttp.topology === 'control-plane' && withHttp.transport).toBeNull();
    const queue = resolveTopology({
      topology: 'control-plane',
      verifyTenant,
      transport: transports.queue(),
    });
    expect(queue.topology === 'control-plane' && queue.transport?.driver).toBe('queue');
  });

  it('refuses a transport on standalone and anything not built by transports.*', () => {
    expect(() => defineConfig({ transport: transports.redis() })).toThrow(
      /only applies to topology 'tenant' or 'control-plane'/,
    );
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant,
        transport: { driver: 'kafka' } as never,
      }),
    ).toThrow(/must be built with transports/);
    expect(() => transports.http({ url: 'ftp://x' })).toThrow(/absolute http/);
    expect(() => transports.bullmq({} as never)).toThrow(/needs a `connection`/);
  });

  it('imports a peer only when the driver is used', async () => {
    const load = vi.fn(async () => fakeBullmq().module);
    const transport = bullmqTransport({ connection: {} }, load);
    expect(load).not.toHaveBeenCalled();
    await transport.tenant({});
    expect(load).toHaveBeenCalledOnce();
  });

  it('says what is missing when the app has no queue, redis or durable configured', async () => {
    const app = {
      container: { make: async () => ({}), hasBinding: () => false },
      config: { get: <T>(_key: string, fallback?: T) => fallback as T },
    };
    await expect(transports.queue().tenant({ app })).rejects.toThrow(/@adonisjs\/queue configured/);
    await expect(transports.redis().tenant({ app })).rejects.toThrow(/@adonisjs\/redis configured/);
    await expect(transports.durable().tenant({ app })).rejects.toThrow(
      /@adonis-agora\/durable configured/,
    );
    await expect(
      transports
        .durable({ transport: 'nope' })
        .tenant({ app: { ...app, config: { get: <T>() => ({ transports: {} }) as T } } }),
    ).rejects.toThrow(/no transport "nope"/);
  });

  it('resolves the connection from the app: config/queue.ts, the redis service, config/durable.ts', async () => {
    const adapter = new FakeQueueAdapter();
    const redis = new FakeRedis();
    const durable = new FakeDurableTransport();
    const durableFactory = vi.fn(async () => durable);
    const config: Record<string, unknown> = {
      queue: { default: 'redis', adapters: { redis: () => adapter } },
      durable: { transport: 'queue', transports: { queue: durableFactory } },
    };
    const app = {
      container: {
        make: async (binding: unknown) =>
          binding === 'redis'
            ? { connection: (name?: string) => (name === 'events' ? redis : null) }
            : null,
        hasBinding: (binding: unknown) => binding === 'redis',
      },
      config: { get: <T>(key: string, fallback?: T) => (config[key] ?? fallback) as T },
    };
    const queueChannel = await transports.queue().tenant({ app });
    expect(
      await queueChannel.send({
        id: 'b1',
        body: '{"version":1,"entries":[]}',
        entries: 0,
        token: 't',
        partition: 'shop',
      }),
    ).toEqual({ kind: 'ok' });
    expect(adapter.size('telescope-ingest')).toBe(1);

    const redisChannel = await transports.redis({ connection: 'events' }).tenant({ app });
    await redisChannel.send({
      id: 'b2',
      body: '{"version":1,"entries":[]}',
      entries: 0,
      token: 't',
      partition: 'shop',
    });
    expect(redis.streams.get('telescope:ingest')).toHaveLength(1);

    await transports.durable().tenant({ app });
    expect(durableFactory).toHaveBeenCalledWith({ app });
    // A tenant only produces: it never competes for durable's queues.
    expect(durable.deferred).toBe(true);
    expect(await transports.redis({ client: redis }).ping({})).toMatch(/Redis answers/);
  });
});
