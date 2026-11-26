import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TelescopeUiProvider from '../../providers/telescope_ui_provider.js';
import { resolveConfig } from '../../src/define_config.js';
import { EntryType } from '../../src/entry.js';
import { consoleCommandHandler } from '../../src/federation/answer.js';
import { answerConsoleCommands } from '../../src/federation/console_commands.js';
import {
  resetTelescopeRuntime,
  setTelescopeQueueManager,
  setTelescopeRuntime,
} from '../../src/registry.js';
import { LucidTelescopeStore } from '../../src/stores/lucid.js';
import { buildConsoleApis } from '../../src/ui/console_apis.js';
import { makeRequest, RecordingResponse } from '../../src/ui/http.js';
import type { QueueManager } from '../../src/watchers/queue_manager.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';
import { FakeRedis } from './fake_redis.js';

/**
 * Two apps in one process, each with its own Lucid (SQLite) telescope store: the Hub runs the
 * console, the shop app records its own entries and answers console commands over a (fake)
 * Redis. The Hub shows the shop app federated: reads straight from the shop's store, actions sent
 * to the shop app.
 */

type Handler = (ctx: unknown) => unknown;
interface Route {
  method: 'GET' | 'POST';
  pattern: string;
  handler: Handler;
}

function fakeRouter(routes: Route[]) {
  const add = (method: Route['method']) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  return { get: add('GET'), post: add('POST') };
}

async function bootConsole(uiConfig: Record<string, unknown>) {
  const routes: Route[] = [];
  const provider = new TelescopeUiProvider({
    inProduction: false,
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'telescope_ui' ? uiConfig : key === 'telescope' ? {} : fallback,
    },
    container: {
      hasBinding: () => false,
      make: async (binding: string) => {
        if (binding === 'logger') return { warn: () => {}, debug: () => {}, info: () => {} };
        if (binding === 'router') return fakeRouter(routes);
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  } as unknown as ApplicationService);
  await provider.boot();
  const route = (method: Route['method'], suffix: string) => {
    const found = routes.find((r) => r.method === method && r.pattern.endsWith(suffix));
    if (!found) throw new Error(`no route ${method} ${suffix}`);
    return found;
  };
  const call = async (
    method: Route['method'],
    suffix: string,
    qs: Record<string, unknown> = {},
    params: Record<string, unknown> = {},
    body: Record<string, unknown> = {},
  ) => {
    const response = new RecordingResponse();
    const ctx = {
      request: {
        ...makeRequest(method, qs),
        body: () => body,
        request: { on: () => {}, socket: {} },
      },
      response: Object.assign(response, {
        response: { writeHead: () => {}, write: () => true, on: () => {} },
      }),
      params,
    };
    await route(method, suffix).handler(ctx);
    return { status: response.statusCode, body: response.body as Record<string, unknown> };
  };
  return { provider, call };
}

/** The shop's queue manager: what a retry reaches on the owning app. */
function fakeQueueManager() {
  const retried: string[] = [];
  const manager: QueueManager = {
    capabilities: ['retry'],
    listQueues: async () => [
      {
        driver: 'fake',
        queue: 'emails',
        counts: { waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0 },
        actions: ['retry'],
      },
    ],
    getJob: async () => null,
    retry: async (queue: string, id: string) => {
      retried.push(`${queue}/${id}`);
    },
  } as unknown as QueueManager;
  return { manager, retried };
}

const SECRET = 'a-shared-secret-of-the-shop';

describe('federated console: the Hub shows the shop app from its own store', () => {
  let hubDb: TestHarness;
  let shopDb: TestHarness;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    hubDb = await makeHarness();
    shopDb = await makeHarness();
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    resetTelescopeRuntime();
    vi.restoreAllMocks();
    await hubDb.cleanup();
    await shopDb.cleanup();
  });

  async function setup(
    options: {
      shopActions?: { queues?: boolean; replay?: boolean };
      authorize?: () => unknown;
      queueActions?: boolean;
    } = {},
  ) {
    // The shop app: its own store, its own entries, answering console commands.
    const shopStore = new LucidTelescopeStore(shopDb.lucid, { autoCreateTable: true });
    const shopRequest = await shopStore.record({
      type: EntryType.Request,
      content: { method: 'POST', url: '/checkout-shop', status: 500 },
      tags: ['status:500'],
      traceId: 'trace-1',
      durationMs: 40,
    });
    const shopQuery = await shopStore.record({
      type: EntryType.Query,
      content: { sql: 'select * from carts' },
      tags: [],
      traceId: 'trace-1',
      durationMs: 7,
    });
    await shopStore.flush();
    const { manager, retried } = fakeQueueManager();
    setTelescopeQueueManager(manager);
    const redis = new FakeRedis();
    const logged: string[] = [];
    stops.push(
      await answerConsoleCommands(
        redis.client(),
        (command) =>
          consoleCommandHandler({
            apis: buildConsoleApis(shopStore, {
              coreConfig: resolveConfig({}),
              uiConfig: { replay: { enabled: options.shopActions?.replay === true } },
              container: { make: async () => null },
              audit: () => {},
            }),
            actions: options.shopActions ?? { queues: true },
            log: (line) => logged.push(line),
          })(command),
        { prefix: 'shop', secret: SECRET },
      ),
    );

    // The Hub: its own store and entries (the start of the trace), its console.
    const hubStore = new LucidTelescopeStore(hubDb.lucid, { autoCreateTable: true });
    const hubRequest = await hubStore.record({
      type: EntryType.Request,
      content: { method: 'GET', url: '/hub-home', status: 200 },
      tags: [],
      traceId: 'trace-1',
      durationMs: 60,
    });
    await hubStore.flush();
    setTelescopeRuntime(hubStore, true);

    const shopRows = async () =>
      Number(
        (
          (await shopDb.db.from('telescope_entries').count('* as total')) as Array<{
            total: number;
          }>
        )[0]?.total,
      );
    const { provider, call } = await bootConsole({
      authorize: options.authorize ?? (() => true),
      ...(options.queueActions ? { queueActions: { enabled: true } } : {}),
      apps: {
        localLabel: 'Hub',
        federated: {
          shop: {
            label: 'Shop',
            // The shop's own table, read with the Hub's connection.
            store: new LucidTelescopeStore(shopDb.lucid),
            commands: { client: redis.client(), prefix: 'shop', secret: SECRET },
            timeoutMs: 2_000,
          },
          // Browsed read-only (`commands` is on by default).
          ledger: {
            label: 'Ledger',
            store: new LucidTelescopeStore(shopDb.lucid),
            commands: false,
          },
        },
      },
    });
    stops.push(() => void provider.shutdown());
    return { call, shopRequest, shopQuery, hubRequest, retried, logged, shopRows };
  }

  it('lists the federated apps in the App picker, with how actions run', async () => {
    const { call } = await setup();
    const { body } = await call('GET', '/api/apps', { app: 'shop' });
    expect(body.data).toEqual({
      enabled: true,
      tag: 'app',
      all: true,
      apps: [
        { id: 'shop', label: 'Shop', mode: 'federated', actions: 'app' },
        { id: 'ledger', label: 'Ledger', mode: 'federated', actions: 'none' },
      ],
      local: { label: 'Hub' },
      selected: 'shop',
    });
  });

  it("reads the shop's entries, traces and Pulse from the shop's store", async () => {
    const { call, shopRequest, hubRequest } = await setup();
    const list = await call('GET', '/api/entries', { app: 'shop' });
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).toContain('/checkout-shop');
    expect(text).not.toContain('/hub-home');

    const one = await call('GET', '/api/entries/:id', { app: 'shop' }, { id: shopRequest.id });
    expect(one.status).toBe(200);
    expect(
      (await call('GET', '/api/entries/:id', { app: 'shop' }, { id: hubRequest.id })).status,
    ).toBe(404);

    const traces = await call('GET', '/api/metrics/traces', { app: 'shop' });
    expect(traces.status).toBe(200);
    expect(JSON.stringify(traces.body)).toContain('trace-1');

    const pulse = await call('GET', '/api/metrics/pulse', { app: 'shop' });
    expect(pulse.status).toBe(200);

    const stats = await call('GET', '/api/metrics/stats', { app: 'shop', type: 'request' });
    expect(stats.status).toBe(200);

    const search = await call('GET', '/api/entries', { app: 'shop', search: 'checkout' });
    expect(JSON.stringify(search.body)).toContain('/checkout-shop');

    const meta = await call('GET', '/api/meta', { app: 'shop' });
    expect(meta.body.data).toMatchObject({
      federated: { app: 'shop', actions: 'app' },
      ai: { enabled: false },
      queueManager: { enabled: true },
    });
  });

  it("merges the shop's spans into the Hub's trace waterfall", async () => {
    const { call, shopQuery, hubRequest } = await setup();
    const waterfall = await call(
      'GET',
      '/api/metrics/waterfall/:traceId',
      {},
      { traceId: 'trace-1' },
    );
    expect(waterfall.status).toBe(200);
    const text = JSON.stringify(waterfall.body);
    expect(text).toContain(hubRequest.id);
    expect(text).toContain(shopQuery.id);

    const trace = await call('GET', '/api/trace/:traceId', {}, { traceId: 'trace-1' });
    const rows = (trace.body as { data: Array<{ id: string; tags: string[] }> }).data;
    expect(rows.find((row) => row.id === shopQuery.id)?.tags).toContain('app:shop');
    // A span only the shop holds opens from the Hub's own view.
    expect((await call('GET', '/api/entries/:id', {}, { id: shopQuery.id })).status).toBe(200);
    // The Hub's own entries list stays the Hub's.
    expect(JSON.stringify((await call('GET', '/api/entries')).body)).not.toContain(
      '/checkout-shop',
    );
  });

  it('sends actions to the shop app, which runs them; the console never writes there', async () => {
    const { call, retried, logged, shopRows } = await setup();
    const before = await shopRows();
    const queues = await call('GET', '/api/queues/live', { app: 'shop' });
    expect(queues.status).toBe(200);
    expect(JSON.stringify(queues.body)).toContain('emails');

    const retry = await call(
      'POST',
      '/api/queues/live/:queue/jobs/:id/retry',
      { app: 'shop' },
      { queue: 'emails', id: '42' },
    );
    expect(retry.status).toBe(200);
    expect(retried).toEqual(['emails/42']);
    expect(logged.join('\n')).toContain('federated console: queues.retry emails/42 by anonymous');

    // The shop did not allow replays: its own answer, relayed.
    const replay = await call('POST', '/api/requests/:id/replay', { app: 'shop' }, { id: 'x' });
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.body)).toContain('consoleCommands.actions.replay');

    expect(await shopRows()).toBe(before);
  });

  it("sends the viewer's capabilities from authorize: a read-only viewer cannot retry", async () => {
    const { call, retried } = await setup({
      authorize: () => ({ allowed: true, capabilities: ['telescope:console:read', 'flags:*'] }),
    });
    expect((await call('GET', '/api/queues/live', { app: 'shop' })).status).toBe(200);
    const retry = await call(
      'POST',
      '/api/queues/live/:queue/jobs/:id/retry',
      { app: 'shop' },
      { queue: 'emails', id: '42' },
    );
    expect(retry.status).toBe(403);
    expect(JSON.stringify(retry.body)).toContain('telescope:console:queues');
    expect(retried).toEqual([]);
  });

  it("the viewer's capabilities apply to the console's own app too (§10.13)", async () => {
    const retryHere = (call: Awaited<ReturnType<typeof setup>>['call']) =>
      call('POST', '/api/queues/live/:queue/jobs/:id/retry', {}, { queue: 'emails', id: '7' });

    const reader = await setup({
      queueActions: true,
      authorize: () => ({ allowed: true, access: 'read' }),
    });
    const refused = await retryHere(reader.call);
    expect(refused).toMatchObject({
      status: 403,
      body: { error: 'The viewer lacks telescope:console:queues.' },
    });
    expect(reader.retried).toEqual([]);
    const meta = await reader.call('GET', '/api/meta');
    expect(meta.body.data).toMatchObject({ viewer: { capabilities: ['telescope:console:read'] } });
    const live = await reader.call('GET', '/api/queues/live');
    expect(JSON.stringify(live.body)).toContain('"mutationsEnabled":false');
    // Every local mutation: profile arming, extension actions, AI diagnosis.
    for (const [suffix, params] of [
      ['/api/profiles/arm', {}],
      ['/api/exceptions/:id/diagnose', { id: 'x' }],
    ] as const) {
      expect(await reader.call('POST', suffix, {}, params)).toMatchObject({
        status: 403,
        body: { error: 'The viewer lacks telescope:console:write.' },
      });
    }
    for (const stop of stops.splice(0)) stop();

    // `telescope:console:write` covers the actions.
    const writer = await setup({
      queueActions: true,
      authorize: () => ({ allowed: true, capabilities: ['telescope:console:write'] }),
    });
    expect((await retryHere(writer.call)).status).toBe(200);
    expect(writer.retried).toEqual(['emails/7']);
  });

  it('a read-only federated app refuses actions; process-local views are not offered', async () => {
    const { call } = await setup();
    const retry = await call(
      'POST',
      '/api/queues/live/:queue/jobs/:id/retry',
      { app: 'ledger' },
      { queue: 'emails', id: '1' },
    );
    expect(retry.status).toBe(403);
    expect(JSON.stringify(retry.body)).toContain('read-only here');
    expect((await call('GET', '/api/queues/live', { app: 'ledger' })).status).toBe(404);
    expect((await call('GET', '/api/profiles/status', { app: 'shop' })).status).toBe(404);
    expect(
      (await call('POST', '/api/exceptions/:id/diagnose', { app: 'shop' }, { id: 'x' })).status,
    ).toBe(404);
  });

  it('an unreachable shop app answers 503 and reads keep working', async () => {
    const { call } = await setup();
    for (const stop of stops.splice(0, 1)) stop(); // the shop stops answering
    const retry = await call(
      'POST',
      '/api/queues/live/:queue/jobs/:id/retry',
      { app: 'shop' },
      { queue: 'emails', id: '42' },
    );
    expect(retry.status).toBe(503);
    expect((await call('GET', '/api/entries', { app: 'shop' })).status).toBe(200);
  });

  it('a viewer limited to other apps cannot read the federated app', async () => {
    const { call } = await setup();
    // Re-boot with a restricted authorize.
    const restricted = await bootConsole({
      authorize: () => ({ allowed: true, apps: ['ledger'] }),
      apps: { federated: { shop: { store: new LucidTelescopeStore(shopDb.lucid) } } },
    });
    const list = await restricted.call('GET', '/api/entries', { app: 'shop' });
    expect(JSON.stringify(list.body)).not.toContain('/checkout-shop');
    const apps = await restricted.call('GET', '/api/apps');
    expect(JSON.stringify(apps.body)).not.toContain('"shop"');
    expect((await call('GET', '/api/entries', { app: 'shop' })).status).toBe(200);
  });
});
