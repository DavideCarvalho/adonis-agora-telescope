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

type Executing = (command: unknown, isMain: boolean) => Promise<void> | void;

/** A stand-in for ace's kernel (`node ace <command>` binds it as `ace`). */
function fakeKernel() {
  const hooks: Executing[] = [];
  return {
    executing: (callback: Executing) => {
      hooks.push(callback);
    },
    /** Run `command` as ace would: the executing hooks, then the command. */
    run: async (command: unknown, isMain = true) => {
      for (const hook of hooks) await hook(command, isMain);
    },
  };
}

/** An ace command instance (`staysAlive` read from its class options, as BaseCommand does). */
function aceCommand(commandName: string, options: { staysAlive?: boolean } = {}) {
  class Command {
    static commandName = commandName;
    static options = options;
    get staysAlive() {
      return Command.options.staysAlive;
    }
  }
  return new Command();
}

function fakeApp(
  config: Record<string, unknown>,
  environment = 'web',
  kernel: ReturnType<typeof fakeKernel> | null = null,
) {
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
        if (key === 'ace') {
          if (kernel === null) throw new Error('Cannot resolve binding "ace"');
          return kernel;
        }
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

async function boot(
  config: Record<string, unknown>,
  environment = 'web',
  kernel: ReturnType<typeof fakeKernel> | null = null,
) {
  const fake = fakeApp(config, environment, kernel);
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

  it('a console process reports nothing until ace runs a command that qualifies', async () => {
    await boot({ telescope: defineConfig({}) }, 'console');
    expect(getTelescopeRuntime().reporter).toBeNull();
    expect(getTelescopeRuntime().fleet).not.toBeNull();
  });

  it('a long-running ace command (staysAlive) reports as a worker under its name', async () => {
    const kernel = fakeKernel();
    const { provider } = await boot(
      { telescope: defineConfig({ fleet: { app: 'shop', version: 'v9' } }) },
      'console',
      kernel,
    );
    // Booted, the command not yet known: nothing reports.
    await provider.ready();
    expect(getTelescopeRuntime().reporter).toBeNull();

    await kernel.run(aceCommand('durable:work', { staysAlive: true }));
    const runtime = getTelescopeRuntime();
    expect(runtime.reporter?.role).toBe('durable:work');
    await runtime.reporter?.beat();
    const [app] = (await runtime.fleet?.view()) ?? [];
    expect(app?.instances).toHaveLength(1);
    expect(app?.instances[0]).toMatchObject({
      role: 'durable:work',
      status: 'up',
      version: 'v9',
      // A worker serves no HTTP: never a discovery target.
      url: null,
    });
    expect(app?.roles).toEqual([
      { role: 'durable:work', counts: { up: 1, starting: 0, draining: 0, gone: 0 } },
    ]);

    // SIGTERM: ace terminates the app, the worker drains like a web process.
    const store = runtime.fleet?.store as MemoryFleetStore;
    providers.pop();
    await provider.shutdown();
    expect(await store.list()).toMatchObject([{ role: 'durable:work', state: 'draining' }]);
  });

  it('a worker drains on SIGTERM while its command still runs; the signal stays its own', async () => {
    const kernel = fakeKernel();
    await boot({ telescope: defineConfig({ fleet: { app: 'shop' } }) }, 'console', kernel);
    const before = process.listenerCount('SIGTERM');
    await kernel.run(aceCommand('durable:work', { staysAlive: true }));
    // The command handles SIGTERM itself (durable:work drains its executions first).
    const commandHandler = () => {};
    process.once('SIGTERM', commandHandler);
    try {
      process.emit('SIGTERM', 'SIGTERM');
      const runtime = getTelescopeRuntime();
      expect(runtime.reporter?.currentState).toBe('draining');
      await runtime.reporter?.beat();
      expect(await runtime.fleet?.store.list()).toMatchObject([{ state: 'draining' }]);
    } finally {
      process.off('SIGTERM', commandHandler);
    }
    await providers.pop()?.shutdown();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('a one-off ace command (migrations, telescope:*) registers no instance', async () => {
    for (const command of [
      aceCommand('migration:run', { staysAlive: false }),
      aceCommand('telescope:server:status'),
    ]) {
      const kernel = fakeKernel();
      await boot({ telescope: defineConfig({ fleet: { app: 'shop' } }) }, 'console', kernel);
      await kernel.run(command);
      expect(getTelescopeRuntime().reporter).toBeNull();
      expect(await getTelescopeRuntime().fleet?.store.list()).toEqual([]);
      await providers.pop()?.shutdown();
    }
  });

  it('only the main command counts; fleet.report: [web] keeps workers out', async () => {
    const kernel = fakeKernel();
    await boot({ telescope: defineConfig({ fleet: { app: 'shop' } }) }, 'console', kernel);
    await kernel.run(aceCommand('durable:work', { staysAlive: true }), false);
    expect(getTelescopeRuntime().reporter).toBeNull();
    await providers.pop()?.shutdown();

    const webOnly = fakeKernel();
    await boot(
      { telescope: defineConfig({ fleet: { app: 'shop', report: ['web'] } }) },
      'console',
      webOnly,
    );
    await webOnly.run(aceCommand('durable:work', { staysAlive: true }));
    expect(getTelescopeRuntime().reporter).toBeNull();
  });

  it('a worker runs its checks in its heartbeat but mounts no probe route', async () => {
    const kernel = fakeKernel();
    const { routes } = await boot(
      {
        telescope: defineConfig({
          fleet: { app: 'shop' },
          checks: [checks.redis({ write: false })],
          health: { readiness: '/health/ready', liveness: '/health/live' },
        }),
      },
      'console',
      kernel,
    );
    expect(routes.filter((r) => r.pattern.startsWith('/health'))).toEqual([]);
    expect(getTelescopeRuntime().probePaths.size).toBe(0);
    await kernel.run(aceCommand('queue:work', { staysAlive: true }));
    await getTelescopeRuntime().reporter?.beat();
    const [app] = (await getTelescopeRuntime().fleet?.view()) ?? [];
    expect(app?.instances[0]?.role).toBe('queue:work');
    expect(app?.instances[0]?.checks).toMatchObject([{ name: 'redis', status: 'ok' }]);
  });

  it('a tenant worker sends its role with its batches and drains on shutdown', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const { transports } = await import('../../src/index.js');
    const kernel = fakeKernel();
    const { provider } = await boot(
      {
        telescope: defineConfig({
          topology: 'tenant',
          transport: transports.http({ url: 'http://central', fetch }),
          tenant: { partition: 'shop', token: 'secret' },
        }),
      },
      'console',
      kernel,
    );
    await kernel.run(aceCommand('durable:work', { staysAlive: true }));
    providers.pop();
    await provider.shutdown();
    const beats = bodies
      .map((b) => b.heartbeat as { state?: string; role?: string } | undefined)
      .filter((h) => h !== undefined);
    // Only the newest heartbeat rides a batch: the last one sent is the draining one.
    expect(beats.at(-1)).toMatchObject({ role: 'durable:work', state: 'draining' });
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
    const send = (heartbeat: Record<string, unknown>) =>
      ingest?.handler({
        request: {
          header: (name: string) =>
            ({ authorization: 'Bearer s1', 'x-telescope-app': 'shop' })[name.toLowerCase()],
          body: () => ({
            version: 1,
            entries: [],
            heartbeat: {
              v: 1,
              host: 'pod-1',
              pid: 7,
              version: 'abc',
              bootedAt: new Date().toISOString(),
              sentAt: new Date().toISOString(),
              state: 'ready',
              intervalMs: 15000,
              checks: [],
              shipping: null,
              ...heartbeat,
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
    await send({ instanceId: 'pod-1' });
    expect(sent.status).toBe(202);
    const apps = (await getTelescopeRuntime().fleet?.view()) ?? [];
    // An older tenant sends no role: its instance is a web one.
    expect(apps.find((a) => a.app === 'shop')?.instances[0]).toMatchObject({
      instanceId: 'pod-1',
      status: 'up',
      role: 'web',
    });
    // A newer tenant's worker carries its role.
    await send({ instanceId: 'pod-1-worker', role: 'durable:work' });
    const [shop] = (await getTelescopeRuntime().fleet?.view(['shop'])) ?? [];
    expect(shop?.roles.map((r) => r.role)).toEqual(['web', 'durable:work']);
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
