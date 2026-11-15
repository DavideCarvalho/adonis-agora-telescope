import { afterEach, describe, expect, it } from 'vitest';
import {
  bullmqTransport,
  type ControlPlaneChannel,
  checks,
  createIngestHandler,
  FleetRegistry,
  HealthChecks,
  InMemoryTelescopeStore,
  type InstanceHeartbeat,
  InstanceReporter,
  MemoryFleetStore,
  type MessageHandler,
  type QueueControlPlaneChannel,
  type RedisControlPlaneChannel,
  RemoteTelescopeStore,
  sharedSecretVerifier,
  type TelescopeTransport,
  type TenantAuthRequest,
  transports,
} from '../../src/index.js';
import {
  FakeDurableTransport,
  FakeQueueAdapter,
  FakeRedis,
  fakeBullmq,
} from '../topology/transport_fakes.js';

const shared = sharedSecretVerifier({
  partitions: { shop: { secret: 'shop-secret', environment: 'production' } },
});
/** Like an authkit token: the token alone names the app, whatever the sender claims. */
const verifyTenant = async (input: TenantAuthRequest) =>
  input.token === 'billing-secret'
    ? { partition: 'billing', capabilities: ['telescope:ingest'] }
    : shared(input);

function controlPlane() {
  const store = new InMemoryTelescopeStore();
  const fleet = new FleetRegistry(new MemoryFleetStore());
  const handler = createIngestHandler({
    verifyTenant,
    store: () => store,
    onHeartbeat: (verified, heartbeat) =>
      fleet.beat(verified.partition, heartbeat, verified.environment ?? null),
  });
  return { store, fleet, handler };
}

interface Kit {
  transport: TelescopeTransport;
  /** Deliver everything the broker holds to the control plane. */
  pump(handler: MessageHandler): Promise<void>;
}

/** HTTP: the tenant's fetch goes straight into the ingest handler, as the route would. */
function httpKit(cp: ReturnType<typeof controlPlane>): Kit {
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const token = headers.authorization?.replace(/^Bearer /, '');
    const answer = await cp.handler.ingest({
      token,
      app: headers['x-telescope-app'],
      body: JSON.parse(String(init.body)),
    });
    expect(String(url)).toBe('https://telescope.test/_telescope/v1/ingest');
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return {
    transport: transports.http({ url: 'https://telescope.test', fetch }),
    pump: async () => {},
  };
}

const brokers: Record<string, () => Kit> = {
  redis: () => {
    const redis = new FakeRedis();
    const transport = transports.redis({ client: redis });
    return {
      transport,
      async pump(handler) {
        const channel = (await transport.controlPlane({})) as RedisControlPlaneChannel;
        while (await channel.once(handler)) {}
      },
    };
  },
  durable: () => {
    const broker = new FakeDurableTransport();
    const transport = transports.durable({ transport: async () => broker });
    let channel: ControlPlaneChannel | null = null;
    return {
      transport,
      async pump(handler) {
        if (channel === null) {
          channel = (await transport.controlPlane({})) as ControlPlaneChannel;
          await channel.start(handler);
        }
        await broker.deliver();
      },
    };
  },
  queue: () => {
    const adapter = new FakeQueueAdapter();
    const transport = transports.queue({ adapter: () => adapter });
    return {
      transport,
      async pump(handler) {
        const channel = (await transport.controlPlane({})) as QueueControlPlaneChannel;
        while (await channel.once(handler)) {}
      },
    };
  },
  bullmq: () => {
    const fake = fakeBullmq();
    const transport = bullmqTransport({ connection: {} }, async () => fake.module);
    let started = false;
    return {
      transport,
      async pump(handler) {
        if (!started) {
          await ((await transport.controlPlane({})) as ControlPlaneChannel).start(handler);
          started = true;
        }
        await fake.drain();
      },
    };
  },
};

const remotes: RemoteTelescopeStore[] = [];
afterEach(() => {
  for (const r of remotes.splice(0)) r.stop();
});

function tenantOf(kit: Kit, token = 'shop-secret', partition = 'shop') {
  const remote = new RemoteTelescopeStore({
    channel: kit.transport.tenant({}),
    partition,
    token,
    buffer: { flushIntervalMs: 60_000 },
  });
  remotes.push(remote);
  const reporter = new InstanceReporter({
    intervalMs: 15_000,
    host: 'web-1',
    version: async () => 'v7',
    checks: new HealthChecks([
      checks.custom('redis', () => ({ status: 'down', message: 'OOM command not allowed' })),
    ]),
    shipping: () => remote.shippingStats(),
    send: (heartbeat) => remote.heartbeat(heartbeat),
  });
  return { remote, reporter };
}

const cases: Array<[string, (cp: ReturnType<typeof controlPlane>) => Kit]> = [
  ['http', httpKit],
  ...Object.entries(brokers).map(([name, make]) => [name, () => make()] as [string, () => Kit]),
];

describe.each(cases)('heartbeat over %s', (_name, makeKit) => {
  it('reaches the fleet, named by the token, with its checks and buffer', async () => {
    const cp = controlPlane();
    const kit = makeKit(cp);
    const { remote, reporter } = tenantOf(kit);
    await remote.record({ type: 'log', content: { message: 'hi' } });
    await reporter.beat();
    await remote.flush();
    await kit.pump((raw) => cp.handler.message(raw));

    // The entry is stored as usual; the heartbeat is not an entry.
    const entries = await cp.store.list();
    expect(entries.map((e) => e.type)).toEqual(['log']);
    const [app] = await cp.fleet.view();
    expect(app?.app).toBe('shop');
    expect(app?.counts).toEqual({ up: 0, starting: 1, draining: 0, gone: 0 });
    expect(app?.instances[0]).toMatchObject({
      instanceId: reporter.instanceId,
      host: 'web-1',
      version: 'v7',
      environment: 'production',
    });
    expect(app?.checks[0]).toMatchObject({
      name: 'redis',
      status: 'down',
      message: 'OOM command not allowed',
    });

    // Ready, then draining at shutdown: each change is sent right away.
    await reporter.setState('ready');
    await remote.flush();
    await kit.pump((raw) => cp.handler.message(raw));
    expect((await cp.fleet.view())[0]?.counts.up).toBe(1);
    await reporter.setState('draining');
    await remote.flush();
    await kit.pump((raw) => cp.handler.message(raw));
    expect((await cp.fleet.view())[0]?.counts.draining).toBe(1);
  });

  it('takes the app from the token, never from the payload or the header', async () => {
    const cp = controlPlane();
    const kit = makeKit(cp);
    // Billing's token, claiming to be "shop".
    const { remote, reporter } = tenantOf(kit, 'billing-secret', 'shop');
    await reporter.beat();
    await remote.flush();
    await kit.pump((raw) => cp.handler.message(raw));
    const apps = await cp.fleet.view();
    expect(apps.map((a) => a.app)).toEqual(['billing']);
  });
});

describe('heartbeat in the tenant buffer', () => {
  it('only the newest is kept, it takes no buffer slot, and survives a failed send', async () => {
    const sent: string[] = [];
    let down = true;
    const remote = new RemoteTelescopeStore({
      channel: {
        send: async (batch) => {
          if (down) return { kind: 'failed', message: 'ECONNREFUSED' };
          sent.push(batch.body);
          return { kind: 'ok' };
        },
      },
      partition: 'shop',
      token: 't',
      buffer: { maxEntries: 1, flushIntervalMs: 60_000, retry: { baseMs: 1, maxMs: 1 } },
    });
    remotes.push(remote);
    const beat = (state: 'starting' | 'ready') =>
      ({
        v: 1,
        instanceId: 'i',
        host: 'h',
        pid: 1,
        version: null,
        bootedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        state,
        intervalMs: 15000,
        checks: [],
        shipping: null,
      }) satisfies InstanceHeartbeat;
    await remote.record({ type: 'log', content: {} });
    await remote.record({ type: 'log', content: {} });
    remote.heartbeat(beat('starting'));
    await remote.flush();
    expect(remote.stats()).toMatchObject({ buffered: 1, dropped: 1 });
    remote.heartbeat(beat('ready'));
    down = false;
    await new Promise((r) => setTimeout(r, 5));
    await remote.flush();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0] as string);
    expect(body.entries).toHaveLength(1);
    expect(body.heartbeat.state).toBe('ready');
    expect(remote.shippingStats()).toMatchObject({ buffered: 0, dropped: 1, sent: 1, lagMs: 0 });
  });

  it('an old control plane (no onHeartbeat) ignores it and still stores the entries', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({ verifyTenant, store: () => store });
    const answer = await handler.ingest({
      token: 'shop-secret',
      app: 'shop',
      body: { version: 1, entries: [], heartbeat: { v: 1 } },
    });
    expect(answer.status).toBe(202);
  });
});
