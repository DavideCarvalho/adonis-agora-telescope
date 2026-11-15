import { mkdtempSync, rmSync } from 'node:fs';
import http, { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryClient, readSnapshot, writeSnapshot } from '../../src/discovery/client.js';
import { defaultSnapshotPath, resolveDiscovery } from '../../src/discovery/config.js';
import {
  DISCOVERY_SLOT,
  type DiscoveryContract,
  ServiceDirectory,
} from '../../src/discovery/directory.js';
import { type RunningDiscovery, startDiscovery } from '../../src/discovery/index.js';
import { DiscoveryError, rewriteTarget } from '../../src/discovery/rewrite.js';
import { buildDiscoveryMap, DiscoveryPublisher } from '../../src/discovery/server.js';
import type { InstanceHeartbeat } from '../../src/fleet/heartbeat.js';
import { normalizeHeartbeat } from '../../src/fleet/heartbeat.js';
import { FleetRegistry } from '../../src/fleet/registry.js';
import { MemoryFleetStore } from '../../src/fleet/store.js';
import { resolveTopology } from '../../src/topology/config.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { registerIngestRoutes } from '../../src/topology/routes.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { resolvePropagation } from '../../src/tracing/config.js';
import { installPropagation } from '../../src/tracing/index.js';
import { newTraceScope, runInTraceScope } from '../../src/tracing/scope.js';

/** A server answering with what it received: path and trace header. */
async function echoServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((req: IncomingMessage, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, traceparent: req.headers.traceparent ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const PASSTHROUGH = new Set(['localhost', 'minio']);

describe('which calls are rewritten', () => {
  const directory = new ServiceDirectory({ billing: 'https://billing.internal/api' });
  directory.update({
    version: 'v1',
    apps: {
      billing: { url: 'https://registry-billing.internal', live: 1 },
      search: { url: 'https://search.internal', live: 2 },
      mailer: { url: 'https://mailer.internal', live: 0 },
    },
  });
  const options = { passthrough: PASSTHROUGH, failFast: false };

  it('an app name goes to its URL, the static map winning, with its base path', () => {
    expect(rewriteTarget(directory, options, 'http://billing/invoices/1')).toEqual({
      origin: 'https://billing.internal',
      basePath: '/api',
      app: 'billing',
    });
    expect(rewriteTarget(directory, options, 'http://SEARCH')?.origin).toBe(
      'https://search.internal',
    );
  });

  it('never touches a host with a dot, an IP, localhost or a passthrough host', () => {
    for (const url of [
      'https://billing.internal/x',
      'http://127.0.0.1:3000/',
      'http://[::1]:3000/',
      'http://localhost:3333/',
      'http://minio:9000/bucket',
    ]) {
      expect(rewriteTarget(directory, options, url)).toBeNull();
    }
  });

  it('by default an unknown single-label host goes out untouched (a Compose service)', () => {
    expect(rewriteTarget(directory, options, 'http://languagetool:8010/v2/check')).toBeNull();
    expect(rewriteTarget(directory, options, 'http://nope/x')).toBeNull();
  });

  it('strict: an unknown name fails clearly, passthrough hosts still go out', () => {
    const strict = { ...options, strict: true };
    expect(() => rewriteTarget(directory, strict, 'http://nope/x')).toThrow(
      /app nope is not registered/,
    );
    expect(rewriteTarget(directory, strict, 'http://minio:9000/bucket')).toBeNull();
    expect(rewriteTarget(directory, strict, 'http://billing/x')?.origin).toBe(
      'https://billing.internal',
    );
  });

  it('an app with no live instance: the last URL, or a failure with failFast', () => {
    expect(rewriteTarget(directory, options, 'http://mailer/')?.origin).toBe(
      'https://mailer.internal',
    );
    expect(() =>
      rewriteTarget(directory, { ...options, failFast: true }, 'http://mailer/'),
    ).toThrow(/app mailer has no live instance/);
  });
});

describe('config', () => {
  it('app keys and options side by side', () => {
    const resolved = resolveDiscovery({
      Billing: 'http://localhost:3334/',
      snapshotPath: '/tmp/x.json',
      failFast: true,
    });
    expect(resolved.apps).toEqual({ billing: 'http://localhost:3334' });
    expect(resolved.snapshotPath).toBe('/tmp/x.json');
    expect(resolved.failFast).toBe(true);
    expect(resolved.strict).toBe(false);
    expect(resolveDiscovery({ strict: true }).strict).toBe(true);
    expect(() => resolveDiscovery({ billing: 'not a url' })).toThrow(/absolute http/);
    expect(() => resolveDiscovery({ 'billing.prod': 'http://x' })).toThrow(/single DNS label/);
  });
});

describe('fetch and http.request by app name (standalone, static map, strict)', () => {
  let billing: { url: string; server: Server };
  let discovery: RunningDiscovery | null;
  let stopTrace: () => void = () => {};

  beforeAll(async () => {
    billing = await echoServer();
    discovery = await startDiscovery({
      config: resolveDiscovery({ billing: `${billing.url}/v1`, nodeHttp: true, strict: true }),
      topology: resolveTopology({}),
    });
  });

  afterAll(async () => {
    stopTrace();
    await discovery?.stop();
    await closeServer(billing.server);
  });

  it('fetch(http://billing/…) reaches billing', async () => {
    const body = (await (await fetch('http://billing/invoices/1?x=2')).json()) as { path: string };
    expect(body.path).toBe('/v1/invoices/1?x=2');
  });

  it('an unknown app name rejects with the discovery error as the cause', async () => {
    const error = (await fetch('http://nope/x').catch((e: unknown) => e)) as Error & {
      cause?: unknown;
    };
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBeInstanceOf(DiscoveryError);
    expect((error.cause as Error).message).toMatch(/app nope is not registered/);
  });

  it('the rewrite runs before the trace interceptor, which sees the real origin', async () => {
    stopTrace = installPropagation(resolvePropagation({ targets: [billing.url] }), true);
    const body = (await runInTraceScope(newTraceScope(), async () =>
      (await fetch('http://billing/charge')).json(),
    )) as { traceparent: string | null };
    expect(body.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    stopTrace();
    stopTrace = () => {};
  });

  it('stays on top when something composes onto the dispatcher later', async () => {
    const slot = globalThis as unknown as Record<
      symbol,
      { compose(i: unknown): unknown } | undefined
    >;
    const keys = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
    const seen: string[] = [];
    const later =
      (dispatch: (o: { origin?: unknown }, h: unknown) => unknown) =>
      (opts: { origin?: unknown }, handler: unknown) => {
        seen.push(String(opts.origin));
        return dispatch(opts, handler);
      };
    // Another library composes onto every slot that exists (Node 24 reads .1, Node 26 reads .2).
    for (const key of keys) {
      const current = slot[key];
      if (current !== undefined) slot[key] = current.compose(later) as never;
    }
    await discovery?.ready();
    await fetch('http://billing/x');
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([new URL(billing.url).origin]));
  });

  it('http.get by app name, with the nodeHttp hook', async () => {
    const body = await new Promise<{ path: string }>((resolve, reject) => {
      http
        .get('http://billing/reports?y=1', (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve(JSON.parse(raw)));
        })
        .on('error', reject);
    });
    expect(body.path).toBe('/v1/reports?y=1');
  });

  it('an unknown app name in http.get is an error event, not a throw, and never hits DNS', async () => {
    const error = await new Promise<unknown>((resolve) => {
      const req = http.get('http://nope/x');
      req.on('error', resolve);
    });
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as Error).message).toMatch(/app nope is not registered/);
  });

  it('publishes the contract other libraries read', () => {
    const contract = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as DiscoveryContract;
    expect(contract.resolve('BILLING')).toBe(`${billing.url}/v1`);
    expect(contract.appOf(billing.url)).toBe('billing');
    expect(contract.resolve('nope')).toBeUndefined();
  });
});

function heartbeat(id: string, url: string | null): InstanceHeartbeat {
  return normalizeHeartbeat({
    v: 1,
    instanceId: id,
    host: 'h',
    pid: 1,
    version: null,
    bootedAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    state: 'ready',
    intervalMs: 15_000,
    checks: [],
    shipping: null,
    url,
  }) as InstanceHeartbeat;
}

describe('the map from the fleet', () => {
  it('live apps with their URL, scoped by environment', () => {
    const now = Date.now();
    const base = {
      host: 'h',
      pid: 1,
      version: null,
      bootedAt: now,
      firstSeenAt: now,
      state: 'ready' as const,
      intervalMs: 15_000,
      checks: [],
      shipping: null,
    };
    const instances = [
      {
        ...base,
        app: 'billing',
        instanceId: 'a',
        environment: 'production',
        lastSeenAt: now - 1000,
        url: 'https://old.billing',
      },
      {
        ...base,
        app: 'billing',
        instanceId: 'b',
        environment: 'production',
        lastSeenAt: now,
        url: 'https://billing.prod',
      },
      {
        ...base,
        app: 'billing',
        instanceId: 'c',
        environment: 'staging',
        lastSeenAt: now,
        url: 'https://billing.staging',
      },
      {
        ...base,
        app: 'search',
        instanceId: 'd',
        environment: 'production',
        lastSeenAt: now - 3_600_000,
        url: 'https://search.prod',
      },
      {
        ...base,
        app: 'nourl',
        instanceId: 'e',
        environment: 'production',
        lastSeenAt: now,
        url: null,
      },
    ];
    const map = buildDiscoveryMap(instances, 'production', now, 3);
    expect(map.apps).toEqual({
      billing: { url: 'https://billing.prod', live: 2 },
      search: { url: 'https://search.prod', live: 0 },
    });
    expect(buildDiscoveryMap(instances, 'staging', now, 3).apps).toEqual({
      billing: { url: 'https://billing.staging', live: 1 },
    });
    expect(buildDiscoveryMap(instances, null, now, 3).apps).toEqual({});
    expect(buildDiscoveryMap(instances, 'production', now, 3).version).toBe(map.version);
  });

  it('the heartbeat carries a sane url only', () => {
    expect(heartbeat('x', 'https://billing.internal/').url).toBe('https://billing.internal');
    expect(heartbeat('x', 'javascript:alert(1)').url).toBeNull();
    expect(heartbeat('x', 'https://user:pass@billing.internal').url).toBeNull();
  });
});

describe('a tenant reading the central server', () => {
  let dir: string;
  let central: Server;
  let centralUrl: string;
  let billing: { url: string; server: Server };
  let fleet: FleetRegistry;
  let publisher: DiscoveryPublisher;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-discovery-'));
    billing = await echoServer();
    fleet = new FleetRegistry(new MemoryFleetStore());
    publisher = new DiscoveryPublisher({
      instances: () => fleet.instances(),
      goneAfterIntervals: 3,
      tickMs: 20,
    });
    const handler = createIngestHandler({
      verifyTenant: sharedSecretVerifier({
        partitions: {
          shop: { secret: 'shop-secret', environment: 'production' },
          intruder: { secret: 'intruder-secret', environment: 'staging' },
        },
      }),
      store: () => null,
    });
    const routes = new Map<string, (ctx: unknown) => unknown>();
    const router = {
      get: (pattern: string, fn: (ctx: unknown) => unknown) => {
        routes.set(pattern, fn);
        return { as: () => undefined };
      },
      post: () => ({ as: () => undefined }),
    };
    registerIngestRoutes(router as never, handler, { path: '/_telescope/v1' } as never, publisher);
    central = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const route = routes.get(url.pathname);
      if (route === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      await route({
        request: {
          header: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
          qs: () => Object.fromEntries(url.searchParams),
        },
        response: {
          header: (k: string, v: string) => res.setHeader(k, v),
          status(code: number) {
            res.statusCode = code;
            return this;
          },
          json(body: unknown) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body));
          },
        },
      });
    });
    await new Promise<void>((resolve) => central.listen(0, '127.0.0.1', () => resolve()));
    centralUrl = `http://127.0.0.1:${(central.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await publisher.close();
    await closeServer(billing.server);
    if (central.listening) await closeServer(central);
    rmSync(dir, { recursive: true, force: true });
  });

  const client = (directory: ServiceDirectory, secret = 'shop-secret', partition = 'shop') =>
    new DiscoveryClient({
      prefix: `${centralUrl}/_telescope/v1`,
      token: secret,
      partition,
      directory,
      snapshotPath: join(dir, `${partition}.json`),
      waitMs: 2000,
    });

  it('reads the map, scoped to its token, and is told of changes', async () => {
    await fleet.beat('billing', heartbeat('b1', billing.url), 'production');
    const directory = new ServiceDirectory();
    const shop = client(directory);
    expect(await shop.pollOnce()).toBe(true);
    expect(directory.resolve('billing')).toBe(billing.url);

    // A token of another environment does not see production's apps.
    const other = new ServiceDirectory();
    expect(await client(other, 'intruder-secret', 'intruder').pollOnce()).toBe(true);
    expect(other.resolve('billing')).toBeUndefined();

    // A held poll is answered as soon as the map changes.
    const changed: string[] = [];
    directory.subscribe(() => changed.push(String(directory.resolve('search'))));
    const held = shop.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fleet.beat('search', heartbeat('s1', 'https://search.internal'), 'production');
    publisher.poke();
    expect(await held).toBe(true);
    expect(changed).toEqual(['https://search.internal']);
    expect(readSnapshot(join(dir, 'shop.json'))?.apps.search?.url).toBe('https://search.internal');
  });

  it('a wrong token reads nothing', async () => {
    const directory = new ServiceDirectory();
    expect(await client(directory, 'wrong').pollOnce()).toBe(false);
    expect(directory.resolve('billing')).toBeUndefined();
  });

  it('keeps resolving from the snapshot while the central server is down', async () => {
    await closeServer(central);
    const discovery = await startDiscovery({
      config: resolveDiscovery({
        snapshotPath: join(dir, 'shop.json'),
        serverUrl: centralUrl,
      }),
      topology: resolveTopology({
        topology: 'tenant',
        tenant: { url: centralUrl, partition: 'shop', token: 'shop-secret' },
      }),
    });
    try {
      const body = (await (await fetch('http://billing/after-restart')).json()) as { path: string };
      expect(body.path).toBe('/after-restart');
    } finally {
      await discovery?.stop();
    }
  });
});

describe('telescope’s own calls', () => {
  it('a token is read as telescope work, so a single-label issuer host is never rewritten', async () => {
    const discovery = await startDiscovery({
      config: resolveDiscovery({ other: 'http://127.0.0.1:1', strict: true }),
      topology: resolveTopology({}),
    });
    try {
      let cause: unknown;
      const client = new DiscoveryClient({
        prefix: 'http://127.0.0.1:9/_telescope/v1',
        // An authkit issuer at `http://authkit-issuer.invalid` would be a dotted host; a Compose
        // one is `http://authkit`. Not an app: it must go out as written (and fail on DNS here),
        // never with "app ... is not registered".
        token: async () => {
          cause = await fetch('http://authkit-issuer/token').catch((e: Error) => e.cause);
          return 'token';
        },
        partition: 'shop',
        directory: new ServiceDirectory(),
        snapshotPath: join(tmpdir(), `telescope-discovery-own-${process.pid}.json`),
        waitMs: 100,
      });
      await client.pollOnce(100);
      expect(cause).toBeDefined();
      expect(cause).not.toBeInstanceOf(DiscoveryError);
      // Outside telescope work the same call is refused by discovery.
      const outside = await fetch('http://authkit-issuer/token').catch((e: Error) => e.cause);
      expect(outside).toBeInstanceOf(DiscoveryError);
    } finally {
      await discovery?.stop();
    }
  });
});

describe('review follow-ups', () => {
  it('mirrors the server map: a name the server dropped no longer resolves', () => {
    const directory = new ServiceDirectory();
    directory.update({ version: '1', apps: { billing: { url: 'https://b.internal', live: 1 } } });
    directory.update({ version: '2', apps: {} });
    expect(directory.lookup('billing')).toEqual({ kind: 'unknown' });
  });

  it('resolve() answers where the call goes, down apps included unless failFast', () => {
    const map = { version: '1', apps: { mailer: { url: 'https://m.internal', live: 0 } } };
    const lenient = new ServiceDirectory();
    lenient.update(map);
    expect(lenient.resolve('mailer')).toBe('https://m.internal');
    const strict = new ServiceDirectory({}, { failFast: true });
    strict.update(map);
    expect(strict.resolve('mailer')).toBeUndefined();
  });

  it('a snapshot is read back only by the scope that wrote it, and each app has its own file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telescope-snapshot-'));
    try {
      const path = join(dir, 'shared.json');
      await writeSnapshot(path, { version: 'v', apps: {} }, 'https://cp/_telescope/v1#shop');
      expect(readSnapshot(path, 'https://cp/_telescope/v1#billing')).toBeNull();
      expect(readSnapshot(path, 'https://cp/_telescope/v1#shop')?.version).toBe('v');
      expect(defaultSnapshotPath('shop')).not.toBe(defaultSnapshotPath('billing'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a held poll is dropped when the caller hangs up', async () => {
    const fleet = new FleetRegistry(new MemoryFleetStore());
    const publisher = new DiscoveryPublisher({
      instances: () => fleet.instances(),
      goneAfterIntervals: 3,
      tickMs: 10_000,
    });
    const { version } = await publisher.current(null);
    const hangUp = new AbortController();
    const held = publisher.wait(null, version, 30_000, hangUp.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(publisher.pending).toBe(1);
    hangUp.abort();
    expect((await held).version).toBe(version);
    expect(publisher.pending).toBe(0);
    await publisher.close();
  });
});
