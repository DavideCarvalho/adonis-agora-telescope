import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMetaData } from '../../commands/main.js';
import TelescopeProvider from '../../providers/telescope_provider.js';
import { defineConfig } from '../../src/define_config.js';
import { telescopeDoctorChecks } from '../../src/doctor/checks.js';
import {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopeRuntime,
} from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { resolveTopology } from '../../src/topology/config.js';
import { csrfExempts, telescopeCsrfExceptions } from '../../src/topology/doctor.js';
import { activeRemoteStores, RemoteTelescopeStore } from '../../src/topology/remote_store.js';
import { appsInStore, telescopeTopologyStatus } from '../../src/topology/status.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';

type Handler = (ctx: unknown) => unknown;

function fakeApp(config: Record<string, unknown>) {
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  const values = new Map<string, unknown>();
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  const app = {
    inProduction: false,
    config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => values.set(key, value),
      singleton: () => {},
      make: async (key: string) => {
        if (key === 'router') return { post: add('POST'), get: add('GET') };
        if (key === 'logger') return { warn: () => {}, debug: () => {}, info: () => {} };
        return values.get(key);
      },
    },
  };
  return { app: app as unknown as ApplicationService, routes, values };
}

function ctx(headers: Record<string, string>, body: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    sent,
    ctx: {
      request: { header: (name: string) => lower[name.toLowerCase()], body: () => body },
      response: {
        header: () => undefined,
        status(code: number) {
          sent.status = code;
          return this;
        },
        json(value: unknown) {
          sent.body = value;
          return value;
        },
      },
    },
  };
}

const providers: TelescopeProvider[] = [];
async function boot(config: Record<string, unknown>) {
  const fake = fakeApp(config);
  const provider = new TelescopeProvider(fake.app);
  providers.push(provider);
  provider.register();
  await provider.boot();
  return { ...fake, provider };
}

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.shutdown();
  for (const store of [...activeRemoteStores]) store.stop();
  vi.unstubAllGlobals();
  resetTelescopeRuntime();
});

/** No overload guard or OTel in these tests: only the topology matters. */
const quiet = { overload: { enabled: false }, watchers: [] as never[] };

const serverConfig = defineConfig({
  ...quiet,
  topology: 'control-plane',
  verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
});

describe('provider', () => {
  it('a control plane registers the ingest routes and writes into its telescope store', async () => {
    const { routes } = await boot({ telescope: serverConfig });
    expect(routes.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      'POST /_telescope/v1/ingest',
      'GET /_telescope/v1/whoami',
    ]);
    const ingest = routes[0]?.handler as Handler;
    const ok = ctx(
      { authorization: 'Bearer shop-secret', 'x-telescope-app': 'shop', 'content-length': '200' },
      { version: 1, entries: [{ id: '1', type: 'log', content: {}, tags: ['app:other'] }] },
    );
    await ingest(ok.ctx);
    expect(ok.sent).toEqual({ status: 202, body: { accepted: 1, duplicates: 0, rejected: 0 } });
    const store = getTelescopeRuntime().store;
    expect((await store?.list())?.[0]?.tags).toEqual(['app:shop']);

    const refused = ctx(
      { authorization: 'Bearer wrong', 'x-telescope-app': 'shop' },
      { entries: [] },
    );
    await ingest(refused.ctx);
    expect(refused.sent.status).toBe(401);
    const tooBig = ctx({ 'content-length': String(10 * 1024 * 1024) }, {});
    await ingest(tooBig.ctx);
    expect(tooBig.sent.status).toBe(413);
  });

  it('standalone (nothing configured) and tenant register no route', async () => {
    for (const config of [
      {},
      {
        ...quiet,
        topology: 'tenant',
        tenant: { url: 'http://x', partition: 'a', token: 't' },
      },
    ]) {
      const { routes } = await boot({ telescope: config });
      expect(routes).toEqual([]);
    }
  });

  it('standalone keeps the configured store; a tenant sends to the server and keeps tenant.local', async () => {
    await boot({ telescope: { ...quiet } });
    expect(getTelescopeRuntime().store).toBeTruthy();
    expect(activeRemoteStores.size).toBe(0);
    const standalone = providers.pop();
    await standalone?.shutdown();

    const calls: Array<{ url: string; body: { entries: Array<{ type: string }> } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 202 });
      }),
    );
    const { provider } = await boot({
      telescope: {
        ...quiet,
        stores: {},
        tenant: {
          url: 'http://central:3334/custom',
          partition: 'billing',
          token: 's',
          local: 'memory',
          buffer: { flushIntervalMs: 60_000 },
        },
        topology: 'tenant',
      },
    });
    expect(activeRemoteStores.size).toBe(1);
    const store = getTelescopeRuntime().store;
    await store?.record({ type: 'log', content: { password: 'hunter2' } });
    // The local copy answers the app's own console.
    expect(await store?.count()).toBe(1);
    // Shutdown sends what is buffered.
    await provider.shutdown();
    providers.pop();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://central:3334/custom/ingest');
    expect(calls[0]?.body.entries[0]?.type).toBe('log');
    // Redaction ran in the app before the entry was sent.
    expect(JSON.stringify(calls[0]?.body)).not.toContain('hunter2');
    expect(activeRemoteStores.size).toBe(0);
  });

  it('a tenant.local naming no store fails at boot', async () => {
    const provider = new TelescopeProvider(
      fakeApp({
        telescope: {
          ...quiet,
          topology: 'tenant',
          tenant: { url: 'http://x', partition: 'a', token: 't', local: 'lucid' },
        },
      }).app,
    );
    await expect(provider.boot()).rejects.toThrow(/tenant.local is "lucid"/);
  });

  it('ships telescope:server:status', async () => {
    const names = (await getMetaData()).map((c) => c.commandName);
    expect(names).toContain('telescope:server:status');
  });

  it('shutdown sends what a remote store still buffers', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 202 }));
    const store = new RemoteTelescopeStore({
      url: 'http://central',
      partition: 'a',
      token: 't',
      fetch: fetch as never,
      buffer: { flushIntervalMs: 60_000 },
    }).start();
    await store.record({ type: 'log', content: {} });
    await new TelescopeProvider(fakeApp({}).app).shutdown();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(activeRemoteStores.size).toBe(0);
  });
});

describe('doctor', () => {
  const run = async (id: string, config: Record<string, unknown>) => {
    const check = telescopeDoctorChecks.find((c) => c.id === id);
    if (!check) throw new Error(id);
    return check.run(fakeApp(config).app);
  };

  it('server: telescope must run, the ingest route must pass CSRF', async () => {
    expect(await run('telescope.topology-store', { telescope: serverConfig })).toMatchObject({
      status: 'error',
    });
    setTelescopeRuntime(new InMemoryTelescopeStore(), false);
    expect(await run('telescope.topology-store', { telescope: serverConfig })).toMatchObject({
      status: 'ok',
    });
    expect(
      await run('telescope.ingest-csrf', {
        telescope: serverConfig,
        'shield.csrf': { enabled: true, exceptRoutes: [] },
      }),
    ).toMatchObject({ status: 'error' });
    expect(
      await run('telescope.ingest-csrf', {
        telescope: serverConfig,
        'shield.csrf': {
          enabled: true,
          exceptRoutes: (c: { request: { url(): string } }) =>
            telescopeCsrfExceptions(c.request.url()),
        },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(csrfExempts(undefined, '/x')).toBe(true);
    expect(
      csrfExempts(
        { enabled: true, exceptRoutes: ['/_telescope/v1/ingest'] },
        '/_telescope/v1/ingest',
      ),
    ).toBe(true);
    expect(telescopeCsrfExceptions('/_telescope/v1/ingest?x=1')).toBe(true);
    expect(telescopeCsrfExceptions('/_telescope/v10/ingest')).toBe(false);
  });

  it('tenant: warns when nothing is sent; standalone skips; a bad topology is an error', async () => {
    const tenant = { topology: 'tenant', tenant: { url: 'http://x', partition: 'a', token: 't' } };
    expect(await run('telescope.topology-store', { telescope: tenant })).toMatchObject({
      status: 'warn',
    });
    expect(await run('telescope.topology', { telescope: tenant })).toMatchObject({
      status: 'ok',
      message: 'Sends entries as app "a" to http://x/_telescope/v1.',
    });
    expect(await run('telescope.topology', {})).toMatchObject({ status: 'skip' });
    expect(await run('telescope.server-reachable', {})).toMatchObject({ status: 'skip' });
    expect(
      await run('telescope.topology', { telescope: { topology: 'control-plane' } }),
    ).toMatchObject({ status: 'error' });
  });

  it('tenant (deep): an unreachable server is an error', async () => {
    const result = await run('telescope.server-reachable', {
      telescope: {
        topology: 'tenant',
        tenant: { url: 'http://127.0.0.1:9', partition: 'a', token: 't' },
      },
    });
    expect(result).toMatchObject({ status: 'error' });
  });
});

describe('status', () => {
  it('server: the apps it has entries for; tenant: how the server sees it', async () => {
    const store = new InMemoryTelescopeStore();
    for (const tags of [['app:shop'], ['app:shop'], ['app:billing'], []]) {
      await store.record({ type: 'log', content: {}, tags });
    }
    expect(await appsInStore(store)).toEqual([
      { app: 'shop', entries: 2 },
      { app: 'billing', entries: 1 },
    ]);
    expect(await telescopeTopologyStatus(resolveTopology(serverConfig), store)).toEqual({
      topology: 'control-plane',
      ingest: 'POST /_telescope/v1/ingest',
      running: true,
      apps: [
        { app: 'shop', entries: 2 },
        { app: 'billing', entries: 1 },
      ],
    });
    const fetch = vi.fn(async () => Response.json({ partition: 'shop', environment: 'prod' }));
    expect(
      await telescopeTopologyStatus(
        resolveTopology({
          topology: 'tenant',
          tenant: { url: 'http://central', partition: 'shop', token: 't' },
        }),
        null,
        fetch as never,
      ),
    ).toMatchObject({
      topology: 'tenant',
      accepted: true,
      as: { partition: 'shop', environment: 'prod' },
    });
    expect(await telescopeTopologyStatus(resolveTopology({}), null)).toEqual({
      topology: 'standalone',
    });
  });
});
