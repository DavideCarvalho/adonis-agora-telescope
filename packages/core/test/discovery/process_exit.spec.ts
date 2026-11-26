import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import TelescopeProvider from '../../providers/telescope_provider.js';
import { defineConfig } from '../../src/define_config.js';
import { resetTelescopeRuntime } from '../../src/registry.js';

/**
 * §12: a tenant's long poll to the central server (`/discovery?wait=25`) never keeps a process
 * alive. Only a serving process polls, and termination closes it.
 */

/** A central server that holds every discovery request open, like the real long poll. */
async function holdingServer() {
  const requests: string[] = [];
  const open = new Set<import('node:http').ServerResponse>();
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    open.add(res);
    res.on('close', () => open.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    open,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fakeApp(config: Record<string, unknown>, environment: string) {
  const app = {
    inProduction: false,
    getEnvironment: () => environment,
    appRoot: new URL('../../', import.meta.url),
    config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
    container: {
      hasBinding: () => false,
      bindValue: () => {},
      singleton: () => {},
      make: async (key: string) => {
        if (key === 'router')
          return { post: () => ({ as: () => {} }), get: () => ({ as: () => {} }) };
        if (key === 'logger') return { warn: () => {}, debug: () => {}, info: () => {} };
        throw new Error(`no ${key}`);
      },
    },
  };
  return app as unknown as ApplicationService;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetTelescopeRuntime();
});

async function bootTenant(environment: string) {
  const central = await holdingServer();
  cleanups.push(central.close);
  const provider = new TelescopeProvider(
    fakeApp(
      {
        telescope: defineConfig({
          overload: { enabled: false },
          watchers: [],
          fleet: false,
          topology: 'tenant',
          tenant: {
            url: central.url,
            partition: 'shop',
            token: 'shop-secret',
            buffer: { flushIntervalMs: 60_000 },
          },
          discovery: {
            snapshotPath: join(tmpdir(), `telescope-exit-${process.pid}-${environment}.json`),
          },
        } as never),
      },
      environment,
    ),
  );
  provider.register();
  await provider.boot();
  return { central, provider };
}

describe('tenant clients never keep a process alive (§12)', () => {
  it('an ace (console) process never long-polls, and terminates with nothing open', async () => {
    const { central, provider } = await bootTenant('console');
    await tick(50);
    expect(central.requests.filter((r) => r.includes('/discovery'))).toEqual([]);
    await provider.shutdown();
    expect(central.open.size).toBe(0);
  });

  it('the REPL does not poll either', async () => {
    const { central, provider } = await bootTenant('repl');
    await tick(50);
    expect(central.requests.filter((r) => r.includes('/discovery'))).toEqual([]);
    await provider.shutdown();
  });

  it('a web process polls, and termination aborts the request it holds open', async () => {
    const { central, provider } = await bootTenant('web');
    await tick(100);
    expect(central.requests.some((r) => r.includes('/discovery?wait=25'))).toBe(true);
    expect(central.open.size).toBe(1);
    await provider.shutdown();
    await tick(50);
    expect(central.open.size).toBe(0);
  });
});
