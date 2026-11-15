import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import TelescopeProvider from '../../providers/telescope_provider.js';
import {
  checks,
  defineConfig,
  LucidFleetStore,
  LucidTelescopeStore,
  type MemoryFleetStore,
} from '../../src/index.js';
import { getTelescopeRuntime } from '../../src/registry.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';

type Handler = (ctx: unknown) => unknown;

function fakeApp(config: Record<string, unknown>, environment = 'web') {
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  const redisDown = { value: false };
  const app = {
    inProduction: false,
    getEnvironment: () => environment,
    appRoot: new URL('../../', import.meta.url),
    config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
    container: {
      hasBinding: () => false,
      singleton: () => {},
      make: async (key: string) => {
        if (key === 'router') return { post: add('POST'), get: add('GET') };
        if (key === 'logger') return { warn: () => {}, debug: () => {}, info: () => {} };
        if (key === 'redis') {
          return {
            connection: () => ({
              ping: async () => {
                if (redisDown.value) throw new Error('ECONNREFUSED');
                return 'PONG';
              },
            }),
          };
        }
        return undefined;
      },
    },
  };
  return { app: app as unknown as ApplicationService, routes, redisDown };
}

function probe(route: { handler: Handler } | undefined) {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    header: () => undefined,
    status(code: number) {
      sent.status = code;
      return {
        json: (body: unknown) => {
          sent.body = body;
          return body;
        },
      };
    },
  };
  return Promise.resolve(route?.handler({ response })).then(() => sent);
}

const providers: TelescopeProvider[] = [];
const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function boot(config: Record<string, unknown>, environment = 'web') {
  const fake = fakeApp(config, environment);
  const provider = new TelescopeProvider(fake.app);
  providers.push(provider);
  provider.register();
  await provider.boot();
  return { ...fake, provider };
}

describe('fleet in the provider', () => {
  it('a standalone app reports itself: starting, ready, draining', async () => {
    const { provider } = await boot({
      telescope: defineConfig({ fleet: { app: 'shop', version: 'v9' } }),
    });
    const fleet = getTelescopeRuntime().fleet;
    expect(fleet).not.toBeNull();
    // The first beat is sent at start, asynchronously.
    await getTelescopeRuntime().reporter?.beat();
    let [app] = (await fleet?.view()) ?? [];
    expect(app).toMatchObject({ app: 'shop', counts: { starting: 1, up: 0 } });
    expect(app?.instances[0]?.version).toBe('v9');

    await provider.ready();
    [app] = (await fleet?.view()) ?? [];
    expect(app?.counts.up).toBe(1);

    const store = fleet?.store as MemoryFleetStore;
    providers.pop();
    await provider.shutdown();
    expect((await store.list())[0]?.state).toBe('draining');
    expect(getTelescopeRuntime().fleet).toBeNull();
  });

  it('a console command (node ace) does not report unless fleet.report includes it', async () => {
    await boot({ telescope: defineConfig({}) }, 'console');
    expect(getTelescopeRuntime().reporter).toBeNull();
    expect(getTelescopeRuntime().fleet).not.toBeNull();
  });

  it('fleet: false keeps no fleet and sends no heartbeat', async () => {
    await boot({ telescope: defineConfig({ fleet: false }) });
    expect(getTelescopeRuntime().fleet).toBeNull();
    expect(getTelescopeRuntime().reporter).toBeNull();
  });

  it('a tenant keeps no fleet; its heartbeat rides its batches', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const { transports } = await import('../../src/index.js');
    const { provider } = await boot({
      telescope: defineConfig({
        topology: 'tenant',
        transport: transports.http({ url: 'http://central', fetch }),
        tenant: { partition: 'shop', token: 'secret' },
      }),
    });
    expect(getTelescopeRuntime().fleet).toBeNull();
    await provider.ready();
    providers.pop();
    await provider.shutdown();
    const states = bodies.map((b) => (b.heartbeat as { state?: string } | undefined)?.state);
    expect(states.at(-1)).toBe('draining');
    expect(states).toContain('ready');
  });

  it('a control plane puts its tenants heartbeats in the fleet (app from the token)', async () => {
    const { routes } = await boot({
      telescope: defineConfig({
        topology: 'control-plane',
        verifyTenant: sharedSecretVerifier({ partitions: { shop: 's1' } }),
      }),
    });
    const ingest = routes.find((r) => r.pattern.endsWith('/ingest'));
    const sent: { status?: number } = {};
    await ingest?.handler({
      request: {
        header: (name: string) =>
          ({ authorization: 'Bearer s1', 'x-telescope-app': 'shop' })[name.toLowerCase()],
        body: () => ({
          version: 1,
          entries: [],
          heartbeat: {
            v: 1,
            instanceId: 'pod-1',
            host: 'pod-1',
            pid: 7,
            version: 'abc',
            bootedAt: new Date().toISOString(),
            sentAt: new Date().toISOString(),
            state: 'ready',
            intervalMs: 15000,
            checks: [],
            shipping: null,
          },
        }),
      },
      response: {
        header: () => undefined,
        status(code: number) {
          sent.status = code;
          return { json: (v: unknown) => v };
        },
      },
    });
    expect(sent.status).toBe(202);
    const apps = (await getTelescopeRuntime().fleet?.view()) ?? [];
    expect(apps.find((a) => a.app === 'shop')?.instances[0]).toMatchObject({
      instanceId: 'pod-1',
      status: 'up',
    });
  });

  it('health probe routes: readiness fails while Redis is down, liveness does not; never recorded', async () => {
    const { routes, redisDown, provider } = await boot({
      telescope: defineConfig({
        checks: [checks.redis({ write: false, cacheFor: 1 })],
        health: { readiness: '/health/ready', liveness: '/health/live' },
      }),
    });
    await provider.ready();
    const ready = routes.find((r) => r.pattern === '/health/ready');
    const live = routes.find((r) => r.pattern === '/health/live');
    expect(await probe(ready)).toEqual({
      status: 200,
      body: { status: 'ok', checks: [{ name: 'redis', status: 'ok' }] },
    });
    redisDown.value = true;
    await new Promise((r) => setTimeout(r, 5));
    expect(await probe(ready)).toEqual({
      status: 503,
      body: { status: 'down', checks: [{ name: 'redis', status: 'down' }] },
    });
    expect((await probe(live)).status).toBe(200);
    expect([...getTelescopeRuntime().probePaths].sort()).toEqual(['/health/live', '/health/ready']);
  });

  it("'auto' puts the fleet's table next to a Lucid entries store", async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    await boot({
      telescope: defineConfig({
        store: 'lucid',
        stores: {
          lucid: async () => new LucidTelescopeStore(harness.lucid, { autoCreateTable: true }),
        },
        fleet: { app: 'shop' },
      }),
    });
    const fleet = getTelescopeRuntime().fleet;
    expect(fleet?.store).toBeInstanceOf(LucidFleetStore);
    await getTelescopeRuntime().reporter?.beat();
    const rows = await harness.db.from('telescope_instances').select('app', 'state');
    expect(rows).toEqual([{ app: 'shop', state: 'starting' }]);
  });
});
