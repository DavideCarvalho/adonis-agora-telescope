import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHKIT_APP_GRAPH_SLOT,
  aggregateCalls,
  hostKey,
  hostResolver,
  readArchitecture,
  SELF_APP,
  stackOf,
} from '../../src/architecture/view.js';
import { DISCOVERY_SLOT } from '../../src/discovery/directory.js';
import { type Entry, EntryType } from '../../src/entry.js';
import type { FleetView } from '../../src/fleet/view.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { buildHttpClientEntry } from '../../src/watchers/http_client_watcher.js';

const slots = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete slots[AUTHKIT_APP_GRAPH_SLOT];
  delete slots[DISCOVERY_SLOT];
});

function call(tags: string[], durationMs: number, at = Date.now()): Entry {
  return {
    id: String(Math.random()),
    type: EntryType.HttpClient,
    familyHash: null,
    content: null,
    tags: ['http-client', ...tags],
    sequence: 0,
    durationMs,
    origin: 'request',
    traceId: null,
    createdAt: new Date(at),
  } as unknown as Entry;
}

function fleetOf(
  apps: Array<{ app: string; url?: string; up?: number; health?: string; stack?: unknown[] }>,
): FleetView {
  return {
    enabled: true,
    notice: null,
    now: Date.now(),
    self: null,
    apps: apps.map((a) => ({
      app: a.app,
      counts: { up: a.up ?? 1, starting: 0, draining: 0, gone: 0 },
      versions: [],
      instances: [
        {
          app: a.app,
          instanceId: `${a.app}-1`,
          url: a.url,
          status: (a.up ?? 1) > 0 ? 'up' : 'gone',
          health: a.health ?? 'ok',
          ...(a.stack ? { stack: a.stack } : {}),
        },
      ],
      roles: [{ role: 'web', counts: { up: 1, starting: 0, draining: 0, gone: 0 } }],
      deploys: [],
      restartLoops: [],
      checks: [],
      shipping: null,
    })),
  } as unknown as FleetView;
}

describe('aggregateCalls', () => {
  it('groups by (from, to), counts failures and percentiles', () => {
    const calls = aggregateCalls(
      [
        call(['app:agora-hub', 'to:entre-textos'], 10),
        call(['app:agora-hub', 'to:entre-textos', 'failed'], 30),
        call(['app:agora-hub', 'to:entre-textos'], 20),
        call(['app:entre-textos', 'host:hub.example.com'], 5),
        call(['app:entre-textos', 'host:api.stripe.com'], 50),
        call(['to:agora-hub'], 7),
      ],
      (host) => (host === 'hub.example.com' ? 'agora-hub' : undefined),
    );
    expect(calls.map((c) => [c.from, c.to, c.count, c.failed, c.avgMs, c.p95Ms])).toEqual([
      ['agora-hub', 'entre-textos', 3, 1, 20, 30],
      ['entre-textos', 'agora-hub', 1, 0, 5, 5],
      [SELF_APP, 'agora-hub', 1, 0, 7, 7],
    ]);
  });

  it('leaves out calls to itself', () => {
    expect(aggregateCalls([call(['app:a', 'to:a'], 1)], () => undefined)).toEqual([]);
  });
});

describe('readArchitecture', () => {
  it('joins fleet, calls and authkit grants; each layer reports its source', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.HttpClient,
      content: null,
      tags: ['http-client', 'app:agora-hub', 'host:et.example.com'],
      durationMs: 12,
    });
    slots[AUTHKIT_APP_GRAPH_SLOT] = {
      snapshot: async () => ({
        apps: [
          { app: 'agora-hub', disabled: false, calls: { 'entre-textos': ['media:objects:read'] } },
          { app: 'eduliberta', disabled: true, calls: { 'agora-hub': ['media:avatars:read'] } },
        ],
        catalogs: [{ app: 'entre-textos', capabilities: ['media:objects:read'] }],
      }),
    };
    const view = await readArchitecture({
      store,
      fleet: fleetOf([
        { app: 'agora-hub' },
        { app: 'entre-textos', url: 'https://et.example.com', health: 'warn' },
        { app: 'eduliberta', up: 0 },
      ]),
    });
    expect(view.sources).toEqual({ fleet: true, calls: true, grants: true, stack: false });
    expect(view.calls.map((c) => [c.from, c.to, c.count])).toEqual([
      ['agora-hub', 'entre-textos', 1],
    ]);
    expect(view.grants).toEqual([
      {
        from: 'agora-hub',
        to: 'entre-textos',
        capabilities: ['media:objects:read'],
        disabled: false,
      },
      { from: 'eduliberta', to: 'agora-hub', capabilities: ['media:avatars:read'], disabled: true },
    ]);
    const byId = Object.fromEntries(view.apps.map((a) => [a.id, a]));
    expect(byId['entre-textos']).toMatchObject({
      health: 'warn',
      instances: 1,
      hasClient: false,
      accepts: ['media:objects:read'],
    });
    expect(byId.eduliberta).toMatchObject({ health: 'down', instances: 0, hasClient: true });
    expect(view.truncated).toBe(false);
  });

  it('without fleet, store or authkit every layer is off', async () => {
    const view = await readArchitecture({ store: null, fleet: null });
    expect(view).toMatchObject({
      apps: [],
      calls: [],
      grants: [],
      sources: { fleet: false, calls: false, grants: false, stack: false },
    });
  });

  it('keeps to the apps the viewer may see', async () => {
    slots[AUTHKIT_APP_GRAPH_SLOT] = {
      snapshot: async () => ({
        apps: [{ app: 'a', disabled: false, calls: { b: [], c: [] } }],
        catalogs: [],
      }),
    };
    const view = await readArchitecture({ store: null, fleet: null, apps: ['a', 'b'] });
    expect(view.grants.map((g) => g.to)).toEqual(['b']);
    expect(view.apps.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('a malformed catalog drops the whole grants layer, not half of it', async () => {
    slots[AUTHKIT_APP_GRAPH_SLOT] = {
      snapshot: async () => ({
        apps: [{ app: 'a', disabled: false, calls: { b: ['x'] } }],
        catalogs: null,
      }),
    };
    const view = await readArchitecture({ store: null, fleet: null });
    expect(view.sources.grants).toBe(false);
    expect(view.grants).toEqual([]);
    expect(view.apps).toEqual([]);
  });

  it('a failing authkit reader turns the grants layer off', async () => {
    slots[AUTHKIT_APP_GRAPH_SLOT] = {
      snapshot: async () => {
        throw new Error('db down');
      },
    };
    const view = await readArchitecture({ store: null, fleet: null });
    expect(view.sources.grants).toBe(false);
  });

  it('flags a window that hit the scan cap', async () => {
    const store = new InMemoryTelescopeStore();
    for (let i = 0; i < 3; i++) {
      await store.record({ type: EntryType.HttpClient, content: null, tags: ['to:x'] });
    }
    const view = await readArchitecture({ store, fleet: null, scanCap: 2 });
    expect(view.truncated).toBe(true);
  });
});

describe('outbound calls carry the target app', () => {
  it('tags to:<app> when discovery knows the origin', () => {
    slots[DISCOVERY_SLOT] = {
      appOf: (origin: string) => (origin === 'https://et.example.com' ? 'entre-textos' : undefined),
    };
    const known = buildHttpClientEntry({
      method: 'GET',
      url: 'https://et.example.com/media/api/object/raw',
      host: 'et.example.com',
      statusCode: 200,
      durationMs: 5,
    } as never);
    expect(known.tags).toContain('to:entre-textos');
    const other = buildHttpClientEntry({
      method: 'GET',
      url: 'https://api.stripe.com/v1',
      host: 'api.stripe.com',
      statusCode: 200,
      durationMs: 5,
    } as never);
    expect(other.tags?.some((t) => t.startsWith('to:'))).toBe(false);
  });
});

describe('hosts', () => {
  it('compares hosts without www., port or case', () => {
    expect(hostKey('WWW.Example.com:443')).toBe('example.com');
  });

  it('maps www. to the app, and the hosts other apps reached the control plane at to itself', () => {
    const resolve = hostResolver(
      fleetOf([{ app: 'entre-textos', url: 'https://entretextos.example.com' }]),
      { app: 'agora-hub', hosts: ['hub-internal:3333'] },
    );
    expect(resolve('www.entretextos.example.com')).toBe('entre-textos');
    expect(resolve('hub-internal')).toBe('agora-hub');
    expect(resolve('api.stripe.com')).toBeUndefined();
  });

  it("a control plane's own untagged calls come from its app", async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: EntryType.HttpClient,
      content: null,
      tags: ['http-client', 'host:www.et.example.com'],
      durationMs: 3,
    });
    const view = await readArchitecture({
      store,
      fleet: fleetOf([
        { app: 'entre-textos', url: 'https://et.example.com' },
        { app: 'agora-hub' },
      ]),
      selfApp: 'agora-hub',
    });
    expect(view.calls.map((c) => [c.from, c.to])).toEqual([['agora-hub', 'entre-textos']]);
  });
});

describe('stack', () => {
  it('one node per backend, shared across apps, with what each app uses it for', async () => {
    const pg = { id: 'postgres:aaaa', tech: 'postgres', label: 'educacao' };
    const view = await readArchitecture({
      store: null,
      fleet: fleetOf([
        { app: 'agora-hub', stack: [{ ...pg, uses: ['app', 'durable'] }] },
        {
          app: 'entre-textos',
          stack: [
            { ...pg, uses: ['app'] },
            { id: 'redis:bbbb', tech: 'redis', label: 'main', uses: ['cache'] },
          ],
        },
      ]),
    });
    expect(view.sources.stack).toBe(true);
    expect(view.infra).toEqual([
      { id: 'postgres:aaaa', tech: 'postgres', label: 'educacao' },
      { id: 'redis:bbbb', tech: 'redis', label: 'main' },
    ]);
    expect(view.uses).toEqual([
      { app: 'agora-hub', infra: 'postgres:aaaa', uses: ['app', 'durable'] },
      { app: 'entre-textos', infra: 'postgres:aaaa', uses: ['app'] },
      { app: 'entre-textos', infra: 'redis:bbbb', uses: ['cache'] },
    ]);
  });

  it('gone instances and hidden apps do not count', () => {
    const fleet = fleetOf([
      { app: 'a', up: 0, stack: [{ id: 'redis:1', tech: 'redis', label: 'x', uses: [] }] },
      { app: 'b', stack: [{ id: 'redis:2', tech: 'redis', label: 'y', uses: [] }] },
    ]);
    expect(stackOf(fleet, (app) => app !== 'b').infra).toEqual([]);
  });
});

describe('readArchitecture with federated apps', () => {
  it("draws each federated app and its calls, read from the app's own store", async () => {
    const hub = new InMemoryTelescopeStore();
    const shop = new InMemoryTelescopeStore();
    // The shop's entries carry no app tag in its own store.
    await shop.record({
      type: EntryType.HttpClient,
      content: null,
      tags: ['http-client', 'to:agora-hub'],
      durationMs: 9,
    });
    const view = await readArchitecture({
      store: hub,
      fleet: null,
      federated: [
        { id: 'shop', store: async () => shop },
        { id: 'ledger', store: async () => Promise.reject(new Error('down')) },
      ],
    });
    expect(view.calls.map((c) => [c.from, c.to, c.count])).toEqual([['shop', 'agora-hub', 1]]);
    const byId = Object.fromEntries(view.apps.map((a) => [a.id, a]));
    expect(byId.shop).toMatchObject({ mode: 'federated' });
    expect(byId.ledger).toMatchObject({ mode: 'federated' });
    expect(byId['agora-hub']?.mode).toBeUndefined();
  });

  it('leaves out a federated app the viewer may not see', async () => {
    const view = await readArchitecture({
      store: new InMemoryTelescopeStore(),
      fleet: null,
      apps: ['other'],
      federated: [{ id: 'shop', store: async () => new InMemoryTelescopeStore() }],
    });
    expect(view.apps.map((a) => a.id)).not.toContain('shop');
  });
});
