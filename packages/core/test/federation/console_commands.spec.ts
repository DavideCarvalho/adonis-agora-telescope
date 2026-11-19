import { afterEach, describe, expect, it } from 'vitest';
import {
  answerConsoleCommands,
  ConsoleCommandError,
  ConsoleCommandSender,
  consoleChannels,
  FEDERATED_APP_UNREACHABLE,
  parseReply,
} from '../../src/federation/console_commands.js';
import { FederatedApp, Federation, TraceMergingStore } from '../../src/federation/federation.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { withFederatedApps } from '../../src/ui/app_scope.js';
import { FakeRedis } from './fake_redis.js';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('console commands over Redis', () => {
  it('exactly one instance runs each command; the reply comes back', async () => {
    const redis = new FakeRedis();
    const runs: string[] = [];
    for (const instance of ['i1', 'i2', 'i3']) {
      stops.push(
        await answerConsoleCommands(
          redis.client(),
          async (command) => {
            runs.push(`${instance}:${command.verb}`);
            return { status: 200, body: { data: command.args } };
          },
          { prefix: 'shop', instanceId: instance },
        ),
      );
    }
    const sender = new ConsoleCommandSender(redis.client(), { app: 'shop', prefix: 'shop' });
    stops.push(() => sender.close());
    const reply = await sender.send('queues.retry', ['emails', '42'], 'user:1');
    expect(reply).toMatchObject({ ok: true, status: 200, body: { data: ['emails', '42'] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toHaveLength(1);
    // The claim key names the instance that ran it.
    const claim = [...redis.keys.keys()].find((key) =>
      key.startsWith(consoleChannels('shop').claim('')),
    );
    expect(claim).toBeDefined();
  });

  it('fails fast when no instance listens', async () => {
    const redis = new FakeRedis();
    const sender = new ConsoleCommandSender(redis.client(), { app: 'shop', prefix: 'shop' });
    stops.push(() => sender.close());
    const started = Date.now();
    const error = await sender.send('health', []).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConsoleCommandError);
    expect((error as ConsoleCommandError).code).toBe(FEDERATED_APP_UNREACHABLE);
    expect((error as Error).message).toMatch(/no instance of the "shop" app answers/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('times out when the app does not answer', async () => {
    const redis = new FakeRedis();
    // Someone listens on the channel but never replies.
    const deaf = redis.client().duplicate();
    await deaf.subscribe(consoleChannels('shop').commands);
    stops.push(() => deaf.disconnect());
    const sender = new ConsoleCommandSender(redis.client(), {
      app: 'shop',
      prefix: 'shop',
      timeoutMs: 50,
    });
    stops.push(() => sender.close());
    await expect(sender.send('health', [])).rejects.toThrow(/did not answer within 50 ms/);
  });

  it('a handler error comes back as an error reply', async () => {
    const redis = new FakeRedis();
    stops.push(
      await answerConsoleCommands(
        redis.client(),
        async () => {
          throw new ConsoleCommandError('nope', 'unsupported-request');
        },
        { prefix: 'shop' },
      ),
    );
    const sender = new ConsoleCommandSender(redis.client(), { app: 'shop', prefix: 'shop' });
    stops.push(() => sender.close());
    expect(await sender.send('x', [])).toEqual({
      id: expect.any(String),
      ok: false,
      error: { message: 'nope', code: 'unsupported-request' },
    });
  });

  it('drops a reply of neither shape', () => {
    expect(parseReply('{"id":"x"}')).toBeNull();
    expect(parseReply('{"id":"x","ok":false}')).toBeNull();
    expect(parseReply('{"id":"x","ok":true}')).toBeNull();
    expect(parseReply('not json')).toBeNull();
    expect(parseReply('{"id":"x","ok":true,"status":200,"body":1}')).toEqual({
      id: 'x',
      ok: true,
      status: 200,
      body: 1,
    });
    expect(parseReply('{"id":"x","ok":false,"error":{"message":"m","code":7}}')).toEqual({
      id: 'x',
      ok: false,
      error: { message: 'm' },
    });
  });

  it('a malformed reply on the channel does not settle the command', async () => {
    const redis = new FakeRedis();
    const forger = redis.client().duplicate();
    await forger.subscribe(consoleChannels('shop').commands);
    forger.on('message', (_channel: string, message: string) => {
      const { id } = JSON.parse(message) as { id: string };
      void redis.client().call('PUBLISH', consoleChannels('shop').replies, JSON.stringify({ id }));
    });
    stops.push(() => forger.disconnect());
    const sender = new ConsoleCommandSender(redis.client(), {
      app: 'shop',
      prefix: 'shop',
      timeoutMs: 80,
    });
    stops.push(() => sender.close());
    await expect(sender.send('health', [])).rejects.toThrow(/did not answer/);
  });

  it('close() fails the commands still waiting, at once', async () => {
    const redis = new FakeRedis();
    const deaf = redis.client().duplicate();
    await deaf.subscribe(consoleChannels('shop').commands);
    stops.push(() => deaf.disconnect());
    const sender = new ConsoleCommandSender(redis.client(), { app: 'shop', prefix: 'shop' });
    const waiting = sender.send('health', []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    sender.close();
    await expect(waiting).rejects.toThrow(/stopped waiting/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('prefixes keep two apps apart', async () => {
    const redis = new FakeRedis();
    const seen: string[] = [];
    for (const prefix of ['a', 'b']) {
      stops.push(
        await answerConsoleCommands(
          redis.client(),
          async () => {
            seen.push(prefix);
            return { status: 200, body: prefix };
          },
          { prefix },
        ),
      );
    }
    const sender = new ConsoleCommandSender(redis.client(), { app: 'b', prefix: 'b' });
    stops.push(() => sender.close());
    expect(await sender.send('health', [])).toMatchObject({ body: 'b' });
    expect(seen).toEqual(['b']);
  });
});

describe('FederatedApp', () => {
  it('maps an unreachable app to 503 and a read-only one to 404', async () => {
    const redis = new FakeRedis();
    const store = new InMemoryTelescopeStore();
    const reachable = new FederatedApp(
      'shop',
      { label: 'Shop', store, commands: { client: redis.client(), prefix: 'shop' } },
      { app: null },
    );
    stops.push(() => reachable.close());
    const down = await reachable.run('health', []);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: FEDERATED_APP_UNREACHABLE });

    const readOnly = new FederatedApp('billing', { store }, { app: null });
    expect(readOnly.actions).toBe('none');
    expect((await readOnly.run('health', [])).status).toBe(404);
  });

  it('builds the store once, read-only, through a provider', async () => {
    let built = 0;
    const app = new FederatedApp(
      'shop',
      {
        store: async () => {
          built += 1;
          return new InMemoryTelescopeStore();
        },
      },
      { app: null },
    );
    const [one, two] = await Promise.all([app.store(), app.store()]);
    expect(one).toBe(two);
    expect(built).toBe(1);
    await expect(one.record({ type: 'log', content: {} })).rejects.toThrow(/only read/);
  });

  it('refuses a key the URL cannot carry, or an app with no store', () => {
    expect(
      () => new Federation({ 'a b': { store: new InMemoryTelescopeStore() } }, { app: null }),
    ).toThrow(/not a valid app key/);
    expect(() => new Federation({ shop: {} as never }, { app: null })).toThrow(/needs a `store`/);
  });

  it('refuses two apps sending commands on the same connection and prefix', () => {
    const store = new InMemoryTelescopeStore();
    expect(
      () =>
        new Federation(
          {
            a: { store, commands: { connection: 'main' } },
            b: { store, commands: { connection: 'main' } },
          },
          { app: null },
        ),
    ).toThrow(/"a" and "b" send commands on the same Redis connection with the same prefix/);
    expect(
      () =>
        new Federation(
          {
            a: { store, commands: { connection: 'main', prefix: 'a' } },
            b: { store, commands: { connection: 'main', prefix: 'b' } },
          },
          { app: null },
        ),
    ).not.toThrow();
  });
});

describe('TraceMergingStore', () => {
  it("merges a trace's spans from the federated apps, tagged with their key", async () => {
    const own = new InMemoryTelescopeStore();
    const shop = new InMemoryTelescopeStore();
    await own.record({ type: 'request', content: {}, tags: ['app:hub'], traceId: 't1' });
    const span = await shop.record({ type: 'query', content: {}, tags: [], traceId: 't1' });
    await shop.record({ type: 'query', content: {}, tags: [], traceId: 'other' });
    const merged = new TraceMergingStore(own, [{ id: 'shop', store: async () => shop }]);
    const rows = await merged.list({ traceId: 't1' });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === span.id)?.tags).toEqual(['app:shop']);
    // An entry only the federated app holds is found by id.
    expect((await merged.get(span.id))?.tags).toEqual(['app:shop']);
    // Other reads are the console's own.
    expect(await merged.list({})).toHaveLength(1);
  });

  it('leaves out a federated app that fails or is slow', async () => {
    const own = new InMemoryTelescopeStore();
    await own.record({ type: 'request', content: {}, traceId: 't1' });
    const merged = new TraceMergingStore(
      own,
      [
        { id: 'down', store: async () => Promise.reject(new Error('refused')) },
        { id: 'slow', store: () => new Promise(() => {}) },
      ],
      20,
    );
    expect(await merged.list({ traceId: 't1' })).toHaveLength(1);
  });
});

describe('withFederatedApps', () => {
  const base = { enabled: true, tag: 'app', all: true, apps: [{ id: 'shop', label: 'Shop' }] };
  const federated = [
    { id: 'et', label: 'Entre Textos', actions: 'app' as const },
    { id: 'edu', label: 'EduLiberta', actions: 'none' as const },
  ];

  it('lists the control plane tenants, then the federated apps, with their modes', () => {
    expect(
      withFederatedApps(base, { all: true }, federated, { controlPlane: true, selected: 'et' }),
    ).toEqual({
      enabled: true,
      tag: 'app',
      all: true,
      apps: [
        { id: 'shop', label: 'Shop', mode: 'control-plane', actions: 'here' },
        { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' },
        { id: 'edu', label: 'EduLiberta', mode: 'federated', actions: 'none' },
      ],
      local: { label: 'All apps' },
      selected: 'et',
    });
  });

  it('a viewer limited to some apps sees only those federated apps', () => {
    const out = withFederatedApps(
      { enabled: true, tag: 'app', all: false, apps: [{ id: 'edu', label: 'edu' }] },
      { all: false, ids: ['edu'] },
      federated,
      { controlPlane: false, localLabel: 'Hub' },
    );
    expect(out.apps).toEqual([
      { id: 'edu', label: 'EduLiberta', mode: 'federated', actions: 'none' },
    ]);
    expect(out.local).toEqual({ label: 'Hub' });
  });

  it('turns the picker on for a standalone console with federated apps', () => {
    const out = withFederatedApps(
      { enabled: false, tag: 'app', all: true, apps: [] },
      { all: true },
      federated,
      { controlPlane: false },
    );
    expect(out.enabled).toBe(true);
    expect(out.local).toEqual({ label: 'This app' });
  });
});
