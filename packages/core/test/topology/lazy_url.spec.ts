import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { DiscoveryClient } from '../../src/discovery/client.js';
import { ServiceDirectory } from '../../src/discovery/directory.js';
import { topologyDoctorChecks } from '../../src/topology/doctor.js';
import {
  type LazyServerUrl,
  RemoteTelescopeStore,
  resolveTopology,
  ServerUrl,
  telescopeTopologyStatus,
  transports,
  whoami,
} from '../../src/topology/index.js';

/** A lazy URL: `urls` in turn on each call (the last repeats), with an optional `refresh()`. */
function lazyUrl(urls: string[], withRefresh = true) {
  const queue = [...urls];
  const next = async () => (queue.length > 1 ? (queue.shift() as string) : (queue[0] as string));
  const fn = vi.fn(next) as unknown as LazyServerUrl & ReturnType<typeof vi.fn>;
  const refresh = vi.fn(next);
  if (withRefresh) fn.refresh = refresh;
  return { fn, refresh };
}

/** A fake fetch: `answer(url)` decides the status, or throws for an unreachable host. */
function fakeFetch(answer: (url: string) => number | Error) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const result = answer(url);
    if (result instanceof Error) throw result;
    return Response.json({ partition: 'shop' }, { status: result });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const stores: RemoteTelescopeStore[] = [];
function tenantStore(url: LazyServerUrl, fetch: typeof globalThis.fetch) {
  const transport = transports.http({ url, fetch });
  const store = new RemoteTelescopeStore({
    channel: transport.tenant({ timeoutMs: 1000 } as never),
    partition: 'shop',
    token: 't',
    buffer: { flushIntervalMs: 60_000, retry: { baseMs: 1, maxMs: 1 } },
  });
  stores.push(store);
  return { store, transport };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

const log = { type: 'log', content: {}, tags: [] };

describe('tenant.url as a function', () => {
  it('is accepted by the config and not called at config time', () => {
    const { fn } = lazyUrl(['https://a.test']);
    const resolved = resolveTopology({
      topology: 'tenant',
      tenant: { url: fn, partition: 'shop', token: 't' },
    });
    expect(resolved.topology === 'tenant' && resolved.transport.driver).toBe('http');
    expect(resolved.topology === 'tenant' && resolved.transport.describe()).toBe(
      'http (URL resolved on first send)',
    );
    expect(fn).not.toHaveBeenCalled();
    expect(() => transports.http({ url: fn })).not.toThrow();
  });

  it('bad strings and non-functions are still refused', () => {
    for (const url of ['ftp://x', 'not a url', '', 42, {}, null]) {
      expect(() =>
        defineConfig({
          topology: 'tenant',
          tenant: { url: url as never, partition: 'shop', token: 't' },
        }),
      ).toThrow(/tenant.url must be an absolute http\(s\) URL, or a function/);
      expect(() => transports.http({ url: url as never })).toThrow(/needs an absolute http\(s\)/);
    }
  });

  it('is resolved on the first send and cached', async () => {
    const { fn } = lazyUrl(['https://a.test']);
    const server = fakeFetch(() => 202);
    const { store, transport } = tenantStore(fn, server.fetch);
    expect(fn).not.toHaveBeenCalled();
    await store.record(log);
    await store.flush();
    await store.record(log);
    await store.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual([
      'https://a.test/_telescope/v1/ingest',
      'https://a.test/_telescope/v1/ingest',
    ]);
    expect(transport.describe()).toBe('http https://a.test/_telescope/v1');
    expect(store.stats()).toMatchObject({ sent: 2, failures: 0 });
  });

  it('a connection error refreshes the URL and retries at the new one', async () => {
    const { fn, refresh } = lazyUrl(['https://old.test', 'https://new.test']);
    const server = fakeFetch((url) =>
      url.startsWith('https://old.test') ? new TypeError('fetch failed') : 202,
    );
    const { store } = tenantStore(fn, server.fetch);
    await store.record(log);
    await store.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual([
      'https://old.test/_telescope/v1/ingest',
      'https://new.test/_telescope/v1/ingest',
    ]);
    expect(store.stats()).toMatchObject({ sent: 1, failures: 0 });
    // Later sends go to the new URL straight away.
    await store.record(log);
    await store.flush();
    expect(server.calls.at(-1)).toBe('https://new.test/_telescope/v1/ingest');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 404 refreshes too; without refresh() the function is called again', async () => {
    const { fn, refresh } = lazyUrl(['https://old.test', 'https://new.test'], false);
    const server = fakeFetch((url) => (url.startsWith('https://old.test') ? 404 : 202));
    const { store } = tenantStore(fn, server.fetch);
    await store.record(log);
    await store.flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(server.calls.at(-1)).toBe('https://new.test/_telescope/v1/ingest');
    expect(store.stats()).toMatchObject({ sent: 1 });
  });

  it('a URL that does not change is not retried, and other statuses never refresh', async () => {
    const { fn, refresh } = lazyUrl(['https://a.test']);
    const server = fakeFetch(() => new TypeError('fetch failed'));
    const { store } = tenantStore(fn, server.fetch);
    await store.record(log);
    await store.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(1);
    expect(store.stats()).toMatchObject({ buffered: 1, lastError: 'fetch failed' });

    const other = lazyUrl(['https://b.test']);
    const refused = fakeFetch(() => 401);
    const second = tenantStore(other.fn, refused.fetch);
    await second.store.record(log);
    await second.store.flush();
    expect(other.refresh).not.toHaveBeenCalled();
  });

  it('a failing or invalid lookup keeps the entries buffered and is tried again', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('issuer down');
      if (calls === 2) return 'not-a-url';
      return 'https://a.test';
    });
    const server = fakeFetch(() => 202);
    const { store } = tenantStore(fn, server.fetch);
    await store.record(log);
    await store.flush();
    expect(store.stats().lastError).toMatch(/cannot be resolved: issuer down/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.flush();
    expect(store.stats().lastError).toMatch(/not an absolute http\(s\) URL/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.flush();
    expect(store.stats()).toMatchObject({ sent: 1, buffered: 0 });
    expect(server.calls).toEqual(['https://a.test/_telescope/v1/ingest']);
  });
});

describe('status and doctor with a lazy URL', () => {
  it('telescope:server:status resolves it (and refreshes when the server is gone)', async () => {
    const { fn, refresh } = lazyUrl(['https://old.test', 'https://new.test']);
    const server = fakeFetch((url) => (url.startsWith('https://old.test') ? 404 : 200));
    const status = await telescopeTopologyStatus(
      resolveTopology({ topology: 'tenant', tenant: { url: fn, partition: 'shop', token: 't' } }),
      null,
      server.fetch,
    );
    expect(status).toMatchObject({
      topology: 'tenant',
      server: 'https://new.test/_telescope/v1',
      accepted: true,
      as: { partition: 'shop' },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('whoami reports a lookup that fails', async () => {
    const result = await whoami({
      url: async () => {
        throw new Error('issuer down');
      },
      partition: 'shop',
      token: 't',
    } as never);
    expect(result).toMatchObject({
      status: 'error',
      message: 'The server URL cannot be resolved: issuer down',
    });
  });

  it('the doctor resolves it for telescope.server-reachable', async () => {
    const run = (id: string, url: LazyServerUrl) => {
      const check = topologyDoctorChecks.find((c) => c.id === id);
      if (!check) throw new Error(id);
      const config = { topology: 'tenant', tenant: { url, partition: 'shop', token: 't' } };
      return check.run({
        config: { get: (key: string) => (key === 'telescope' ? config : undefined) },
      } as never);
    };
    const { fn } = lazyUrl(['http://127.0.0.1:9']);
    expect(await run('telescope.topology', fn)).toMatchObject({
      status: 'ok',
      message:
        'Sends entries as app "shop" to the server tenant.url resolves (looked up on first send).',
    });
    expect(fn).not.toHaveBeenCalled();
    const result = await run('telescope.server-reachable', fn);
    expect(fn).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'error',
      message: expect.stringContaining(
        'The server at http://127.0.0.1:9/_telescope/v1 cannot be reached',
      ),
    });
  });
});

describe('discovery with a lazy URL', () => {
  it('polls the resolved server and looks it up again after a 404', async () => {
    const { fn, refresh } = lazyUrl(['https://old.test', 'https://new.test']);
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return url.startsWith('https://old.test')
        ? new Response('', { status: 404 })
        : Response.json({ version: 'v1', apps: {} });
    }) as unknown as typeof globalThis.fetch;
    const client = new DiscoveryClient({
      prefix: new ServerUrl(fn),
      token: 't',
      partition: 'shop',
      directory: new ServiceDirectory(),
      snapshotPath: join(tmpdir(), `telescope-lazy-discovery-${process.pid}.json`),
      fetch,
    });
    expect(await client.pollOnce(10)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await client.pollOnce(10)).toBe(true);
    expect(calls.map((url) => url.split('?')[0])).toEqual([
      'https://old.test/_telescope/v1/discovery',
      'https://new.test/_telescope/v1/discovery',
    ]);
  });
});
