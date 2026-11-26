import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_CONSOLE_COMMAND_CAPABILITIES,
  CAPABILITIES_REQUIRED,
  type ConsoleCommandActions,
  consoleCommandHandler,
} from '../../src/federation/answer.js';
import {
  answerConsoleCommands,
  type ConsoleChannelAuthOptions,
  type ConsoleCipher,
  type ConsoleCommand,
  ConsoleCommandSender,
  consoleChannels,
  consoleCommandKeys,
  parseConsolePublicKey,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/console_commands.js';
import { FederatedApp } from '../../src/federation/federation.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import type { UiHttpContext } from '../../src/ui/http.js';
import { FakeRedis } from './fake_redis.js';

const SECRET = 'a-shared-secret-of-the-shop';
const APP_KEY = 'app-key-of-the-shop-0123456789';
const channels = consoleChannels('shop');

const stops: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0)) stop();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The console APIs the handler drives, reduced to what each verb answers. */
function fakeApis(ran: string[]) {
  const ok = (what: string) => async (ctx: UiHttpContext) => {
    ran.push(what);
    ctx.response.status(200).send({ data: what });
  };
  return {
    queueManagerApi: {
      list: async (ctx: UiHttpContext, mutations: boolean) => {
        ran.push(`queues.list mutations=${mutations}`);
        ctx.response.status(200).send({ data: { mutations } });
      },
      job: ok('queues.job'),
      retry: ok('queues.retry'),
      enqueue: ok('queues.enqueue'),
    },
    schedulesApi: { live: ok('schedules.live') },
    fleetApi: { health: ok('health') },
    api: { replayRequest: ok('replay') },
  } as never;
}

/** One owning app answering on `shop`, with `auth` and the real handler over fake APIs. */
async function app(
  redis: FakeRedis,
  auth: ConsoleChannelAuthOptions,
  options: { actions?: ConsoleCommandActions; partition?: string } = {},
) {
  const seen: ConsoleCommand[] = [];
  const ran: string[] = [];
  const errors: Array<{ message: string; error: unknown }> = [];
  const logged: string[] = [];
  const handler = consoleCommandHandler({
    apis: fakeApis(ran),
    actions: options.actions ?? { queues: true, replay: true },
    partition: options.partition ?? auth.partition,
    log: (line) => logged.push(line),
  });
  stops.push(
    await answerConsoleCommands(
      redis.client(),
      async (command) => {
        seen.push(command);
        return handler(command);
      },
      { prefix: 'shop', ...auth, onError: (message, error) => errors.push({ message, error }) },
    ),
  );
  return { seen, ran, errors, logged };
}

function sender(redis: FakeRedis, auth: ConsoleChannelAuthOptions, timeoutMs = 2_000) {
  const { secret, crypto, token, publicKey } = auth;
  const made = new ConsoleCommandSender(redis.client(), {
    app: 'shop',
    prefix: 'shop',
    timeoutMs,
    ...(secret !== undefined ? { secret } : {}),
    ...(crypto !== undefined ? { crypto } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
  });
  stops.push(() => made.close());
  // Like the console: every command carries the viewer's capabilities (all of them by default).
  const send = made.send.bind(made);
  made.send = (
    verb,
    args,
    actor,
    extra = { capabilities: [...ALL_CONSOLE_COMMAND_CAPABILITIES] },
  ) => send(verb, args, actor, extra);
  return made;
}

/** Publishes `message` on the shop's command channel as anyone with Redis access. */
const publish = (redis: FakeRedis, message: unknown) =>
  redis
    .client()
    .call(
      'PUBLISH',
      channels.commands,
      typeof message === 'string' ? message : JSON.stringify(message),
    );

/** A forger that answers every command with `body` (no valid MAC). */
async function forger(redis: FakeRedis, body: unknown) {
  const sub = redis.client().duplicate();
  await sub.subscribe(channels.commands);
  sub.on('message', (_channel: string, message: string) => {
    const { id } = JSON.parse(message) as { id: string };
    void redis
      .client()
      .call('PUBLISH', channels.replies, JSON.stringify({ id, ok: true, status: 200, body }));
  });
  stops.push(() => sub.disconnect());
}

const wireText = (redis: FakeRedis) => redis.published.map((p) => p.message).join('\n');

describe('console commands: no authentication', () => {
  it('an app with no mode answers nothing; a console with none sends nothing', async () => {
    const redis = new FakeRedis();
    await expect(
      answerConsoleCommands(redis.client(), async () => ({ status: 200, body: null }), {
        prefix: 'shop',
      }),
    ).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
    const plain = sender(redis, {});
    expect(plain.signed).toBe(false);
    await expect(plain.send('health', [])).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
    expect(redis.published).toHaveLength(0);

    const federated = new FederatedApp(
      'shop',
      { store: new InMemoryTelescopeStore(), commands: { client: redis.client(), prefix: 'shop' } },
      { app: null },
    );
    stops.push(() => federated.close());
    const out = await federated.run('health', []);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('a token needs the app key or crypto', () => {
    const redis = new FakeRedis();
    expect(() => sender(redis, { token: 'hub' })).toThrow(
      /needs `crypto` or the app's `publicKey`/,
    );
    expect(() => parseConsolePublicKey('not-a-key')).toThrow(/x25519:/);
    expect(() => consoleCommandKeys('short')).toThrow(/at least 16/);
  });
});

describe('console commands: shared secret', () => {
  it('runs a signed command and refuses unsigned, forged and tampered ones', async () => {
    const redis = new FakeRedis();
    const { seen, errors } = await app(redis, { secret: SECRET });
    expect(await sender(redis, { secret: SECRET }).send('health', [], 'user:1')).toMatchObject({
      ok: true,
      status: 200,
      body: { data: 'health' },
    });
    expect(seen).toHaveLength(1);

    // Unsigned, with a claimed `verified` and every capability.
    await publish(redis, {
      id: randomUUID(),
      verb: 'queues.retry',
      args: ['emails', '1'],
      capabilities: ['*'],
      verified: { partition: 'shop', capabilities: ['*'] },
    });
    // Signed with another secret.
    const other = new FakeRedis();
    const otherSender = sender(other, { secret: 'not-the-shop-secret-at-all' }, 50);
    await otherSender.send('queues.retry', ['emails', '2']).catch(() => {});
    const forged = other.published.find((p) => p.channel === channels.commands)!.message;
    await publish(redis, forged);
    // A real one, with its verb changed.
    const real = redis.published.find((p) => p.channel === channels.commands)!.message;
    await publish(redis, { ...JSON.parse(real), id: randomUUID(), verb: 'queues.retry' });
    await tick();
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(3);
    for (const { error } of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('runs a replay once, and refuses a stale command', async () => {
    const redis = new FakeRedis();
    const { seen, errors } = await app(redis, { secret: SECRET });
    await sender(redis, { secret: SECRET }).send('queues.retry', ['emails', '1']);
    const real = redis.published.find((p) => p.channel === channels.commands)!.message;
    await publish(redis, real);
    await tick();
    expect(seen).toHaveLength(1);
    // The instance that ran it calls the replay what it is (§11b).
    expect(errors.map((e) => e.message)).toEqual(['replayed']);
    errors.length = 0;

    // Two minutes later, with the claim gone: the signature is stale.
    redis.keys.clear();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    await publish(redis, real);
    await tick();
    expect(seen).toHaveLength(1);
    expect(errors[0]?.error).toMatchObject({ code: UNSIGNED_CHANNEL, message: 'stale' });
  });

  it('ignores a forged answer and waits for the real one', async () => {
    const redis = new FakeRedis();
    await forger(redis, 'forged');
    await app(redis, { secret: SECRET });
    const reply = await sender(redis, { secret: SECRET }).send('health', []);
    expect(reply).toMatchObject({ ok: true, body: { data: 'health' } });
  });

  it('message capabilities only narrow', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { secret: SECRET });
    const console = sender(redis, { secret: SECRET });
    const narrowed = await console.send('queues.retry', ['emails', '1'], 'user:1', {
      capabilities: ['telescope:console:read'],
    });
    expect(narrowed).toMatchObject({ ok: true, status: 403 });
    expect(ran).toEqual([]);
  });
});

describe('console commands: token mode', () => {
  const verifyTenant: TenantVerifier = ({ token }) => {
    if (token === 'hub-admin') {
      return { partition: 'shop', capabilities: ['telescope:console:*'], clientId: 'hub' };
    }
    if (token === 'hub-reader') {
      return { partition: 'shop', capabilities: ['telescope:console:read'], clientId: 'hub-ro' };
    }
    if (token === 'hub-billing') {
      return { partition: 'billing', capabilities: ['*'], clientId: 'hub-billing' };
    }
    return null;
  };
  const keys = consoleCommandKeys(APP_KEY, 'shop');
  const tokenSender = (redis: FakeRedis, token: string, onReset?: () => void) =>
    sender(redis, {
      token: Object.assign(async () => token, { reset: () => onReset?.() }),
      publicKey: keys.publicKey,
    });

  it('derives the same key from the same APP_KEY, and another from another', () => {
    expect(consoleCommandKeys(APP_KEY, 'shop').publicKey).toBe(keys.publicKey);
    expect(keys.publicKey).toMatch(/^x25519:[A-Za-z0-9_-]{43}$/);
    expect(consoleCommandKeys(`${APP_KEY}x`, 'shop').publicKey).not.toBe(keys.publicKey);
    expect(consoleCommandKeys(APP_KEY, 'other').publicKey).not.toBe(keys.publicKey);
  });

  it('runs a command whose token the app verifies; nothing readable on Redis', async () => {
    const redis = new FakeRedis();
    const { seen, ran, logged } = await app(redis, { keys, verifyTenant, partition: 'shop' });
    const reply = await tokenSender(redis, 'hub-admin').send(
      'queues.retry',
      ['emails-queue', '42'],
      'alice@hub',
    );
    expect(reply).toMatchObject({ ok: true, status: 200 });
    expect(ran).toEqual(['queues.retry']);
    expect(seen[0]?.verified).toEqual({
      partition: 'shop',
      capabilities: ['telescope:console:*'],
      clientId: 'hub',
    });
    expect(logged[0]).toContain('queues.retry emails-queue/42 by alice@hub (console hub)');
    const wire = wireText(redis);
    expect(wire).not.toContain('hub-admin');
    expect(wire).not.toContain('emails-queue');
    expect(wire).not.toContain('alice@hub');
  });

  it('refuses an unknown token with 401, and the console drops its cached token', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { keys, verifyTenant, partition: 'shop' });
    let resets = 0;
    const reply = await tokenSender(redis, 'stolen', () => {
      resets += 1;
    }).send('health', []);
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect(ran).toEqual([]);
  });

  it('lets the token decide the app and what the console may do', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { keys, verifyTenant, partition: 'shop' });
    // A token for another app.
    const other = await tokenSender(redis, 'hub-billing').send('health', []);
    expect(other).toMatchObject({ ok: true, status: 403 });
    expect(JSON.stringify(other)).toContain('token is for \\"billing\\"');
    // A read-only token reads, but cannot retry, whatever the message claims.
    const reader = tokenSender(redis, 'hub-reader');
    expect(await reader.send('health', [])).toMatchObject({ status: 200 });
    const retry = await reader.send('queues.retry', ['emails', '1'], 'x', { capabilities: ['*'] });
    expect(retry).toMatchObject({ status: 403 });
    expect(JSON.stringify(retry)).toContain('lacks telescope:console:queues');
    // The live queues view does not offer mutations to it either.
    expect(await reader.send('queues.list', [])).toMatchObject({
      body: { data: { mutations: false } },
    });
    // The message's capabilities narrow the token's.
    const narrowed = await tokenSender(redis, 'hub-admin').send('replay', ['e1'], 'x', {
      capabilities: ['telescope:console:read'],
    });
    expect(narrowed).toMatchObject({ status: 403 });
    expect(ran).toEqual(['health', 'queues.list mutations=false']);
  });

  it("keeps the app's own opt-in: a token cannot run an action the app did not allow", async () => {
    const redis = new FakeRedis();
    await app(redis, { keys, verifyTenant, partition: 'shop' }, { actions: {} });
    const replay = await tokenSender(redis, 'hub-admin').send('replay', ['e1']);
    expect(replay).toMatchObject({ status: 403 });
    expect(JSON.stringify(replay)).toContain('consoleCommands.actions.replay');
  });

  it('an app with no name of its own refuses every token', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { keys, verifyTenant });
    expect(await tokenSender(redis, 'hub-admin').send('health', [])).toMatchObject({
      status: 403,
    });
    expect(ran).toEqual([]);
  });

  it('refuses unsealed, tampered, re-addressed and replayed commands', async () => {
    const redis = new FakeRedis();
    const { seen, errors } = await app(redis, { keys, verifyTenant, partition: 'shop' });
    await publish(redis, {
      id: randomUUID(),
      verb: 'queues.retry',
      args: ['emails', '1'],
      verified: { partition: 'shop', capabilities: ['*'] },
    });
    await tick();
    expect(seen).toHaveLength(0);
    expect(errors[0]?.error).toMatchObject({ code: UNSIGNED_CHANNEL });

    await tokenSender(redis, 'hub-admin').send('queues.retry', ['emails', '1']);
    const sent = redis.published.find(
      (p) => p.channel === channels.commands && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await publish(redis, { id: randomUUID(), sealed: wire.sealed });
    await publish(redis, { ...wire, sealed: flipped });
    await publish(redis, sent.message);
    await tick();
    expect(seen).toHaveLength(1);
    // Sealed to another app's key: it does not open here.
    const elsewhere = sender(
      redis,
      { token: 'hub-admin', publicKey: consoleCommandKeys(`${APP_KEY}-other`, 'shop').publicKey },
      50,
    );
    await elsewhere.send('health', []).catch(() => {});
    await tick();
    expect(seen).toHaveLength(1);
  });

  it('ignores a forged answer', async () => {
    const redis = new FakeRedis();
    await forger(redis, 'forged');
    await app(redis, { keys, verifyTenant, partition: 'shop' });
    expect(await tokenSender(redis, 'hub-admin').send('health', [])).toMatchObject({
      body: { data: 'health' },
    });
  });

  it('accepts a shared secret too, while consoles move over', async () => {
    const redis = new FakeRedis();
    const { seen } = await app(redis, { keys, verifyTenant, partition: 'shop', secret: SECRET });
    expect(await sender(redis, { secret: SECRET }).send('health', [])).toMatchObject({
      status: 200,
    });
    expect(await tokenSender(redis, 'hub-admin').send('health', [])).toMatchObject({
      status: 200,
    });
    expect(seen.map((c) => c.verified?.clientId)).toEqual([undefined, 'hub']);
  });
});

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-telescope', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key) as Buffer, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop() as string, 'base64url');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.keys.get(key) as Buffer,
          raw.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

describe('console commands: sealed with @adonis-agora/crypto', () => {
  const verifyTenant: TenantVerifier = ({ token }) =>
    token === 'hub-admin'
      ? { partition: 'shop', capabilities: ['telescope:console:*'], clientId: 'hub' }
      : null;

  async function setup(options: { verify?: boolean } = {}) {
    const redis = new FakeRedis();
    const server = new FakeCryptoServer();
    // The app may only decrypt with the key.
    const answered = await app(redis, {
      crypto: { cipher: server.cipherFor({ decrypt: ['console-telescope'] }) },
      partition: 'shop',
      ...(options.verify ? { verifyTenant } : {}),
    });
    let resolved = 0;
    // The console may only encrypt with it; lazy, like `() => crypto.client!`.
    const console = (token?: string) =>
      sender(redis, {
        crypto: {
          cipher: () => {
            resolved += 1;
            return server.cipherFor({ encrypt: ['console-telescope'] });
          },
        },
        ...(token !== undefined ? { token } : {}),
      });
    return { redis, server, ...answered, console, resolvedCount: () => resolved };
  }

  it('runs a command the console encrypted and the app decrypted, nothing readable on Redis', async () => {
    const { redis, server, seen, console, resolvedCount } = await setup();
    const made = console();
    expect(resolvedCount()).toBe(0);
    const reply = await made.send('queues.retry', ['emails-queue', '9'], 'alice@hub');
    expect(reply).toMatchObject({ ok: true, status: 200 });
    expect(resolvedCount()).toBe(1);
    expect(seen[0]).toMatchObject({ verb: 'queues.retry', actor: 'alice@hub' });
    expect(seen[0]?.verified).toBeUndefined();
    expect(wireText(redis)).not.toContain('emails-queue');
    expect(wireText(redis)).not.toContain('alice@hub');
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { redis, server, seen, errors } = await setup();
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await publish(redis, { id: randomUUID(), sealed: ciphertext });
    await publish(redis, {
      id: randomUUID(),
      sealed: `agora:ct1:console-telescope:1:${randomBytes(64).toString('base64url')}`,
    });
    await publish(redis, { id: randomUUID(), verb: 'queues.retry', args: [], capabilities: ['*'] });
    await tick(30);
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(3);
    for (const { error } of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { seen, console } = await setup({ verify: true });
    expect(await console().send('health', [])).toMatchObject({
      ok: false,
      error: { code: UNAUTHORIZED_CONSOLE },
    });
    expect(await console('hub-admin').send('health', [])).toMatchObject({ ok: true, status: 200 });
    expect(seen.at(-1)?.verified).toMatchObject({ partition: 'shop', clientId: 'hub' });
  });

  it('ignores a forged answer', async () => {
    const { redis, console } = await setup();
    await forger(redis, 'forged');
    expect(await console().send('health', [])).toMatchObject({ body: { data: 'health' } });
  });

  it('says so when crypto is not ready yet', async () => {
    const redis = new FakeRedis();
    const made = sender(redis, { crypto: { cipher: () => undefined as never } }, 100);
    await expect(made.send('health', [])).rejects.toThrow(/crypto\.cipher.*not ready/);
  });
});

describe('console commands: capabilities are always required', () => {
  it('refuses a command that carries no capabilities (never "missing = everything")', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { secret: SECRET });
    const raw = new ConsoleCommandSender(redis.client(), {
      app: 'shop',
      prefix: 'shop',
      secret: SECRET,
    });
    stops.push(() => raw.close());
    const reply = await raw.send('health', []);
    expect(reply).toMatchObject({ ok: true, status: 403, body: { code: CAPABILITIES_REQUIRED } });
    expect(ran).toEqual([]);
  });

  it('every verb, reads included, needs its capability', async () => {
    const redis = new FakeRedis();
    const { ran } = await app(redis, { secret: SECRET });
    const console = sender(redis, { secret: SECRET });
    const reply = await console.send('health', [], 'x', {
      capabilities: ['telescope:console:queues'],
    });
    expect(reply).toMatchObject({ status: 403 });
    expect(ran).toEqual([]);
  });
});

describe('console commands: authkit app-call tokens', () => {
  const keys = consoleCommandKeys(APP_KEY, 'shop');
  const verifyAppCaller = async (token: string) =>
    token === 'hub-call'
      ? { app: 'hub', capabilities: ['telescope:console:read'], clientId: 'hub-client' }
      : token === 'old-call'
        ? { app: 'hub', capabilities: ['*'], expiresAt: Date.now() - 1 }
        : null;

  it('accepts a token bound to this app by its audience, capped by what authkit granted', async () => {
    const redis = new FakeRedis();
    const { seen } = await app(redis, { keys, verifyAppCaller, partition: 'shop' });
    const console = (token: string) =>
      sender(redis, { token: async () => token, publicKey: keys.publicKey });
    expect(await console('hub-call').send('health', [])).toMatchObject({ status: 200 });
    // The partition is the caller (hub), not this app: no partition rule for app-call tokens.
    expect(seen.at(-1)?.verified).toMatchObject({
      partition: 'hub',
      clientId: 'hub-client',
      appCall: true,
    });
    expect(await console('hub-call').send('queues.retry', ['a', '1'])).toMatchObject({
      status: 403,
    });
    expect(await console('old-call').send('health', [])).toMatchObject({
      ok: false,
      error: { code: UNAUTHORIZED_CONSOLE },
    });
  });
});

describe('console commands: a cipher of your own', () => {
  it('`crypto.owns` lets a KMS with another ciphertext format through', async () => {
    const redis = new FakeRedis();
    const key = randomBytes(32);
    // A KMS-like cipher: `kms:v1:<base64url>`.
    const kms: ConsoleCipher = {
      encrypt: async ({ plaintext, aad }) => {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', key, iv);
        c.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
        return {
          ciphertext: `kms:v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ ciphertext, aad }) => {
        const raw = Buffer.from(ciphertext.slice('kms:v1:'.length), 'base64url');
        const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAAD(Buffer.from(aad ?? ''));
        d.setAuthTag(raw.subarray(12, 28));
        return {
          plaintext: Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'),
        };
      },
    };
    const owns = (ciphertext: string) => ciphertext.startsWith('kms:v1:');
    await app(redis, { crypto: { cipher: kms, key: 'my-kms-key', owns } });
    expect(
      await sender(redis, { crypto: { cipher: kms, key: 'my-kms-key', owns } }).send('health', []),
    ).toMatchObject({ status: 200 });
  });
});

describe('console commands: when a token is required with crypto (§2c)', () => {
  const verifyAppCaller = async (token: string) =>
    token === 'hub-call' ? { app: 'hub', capabilities: ['telescope:console:read'] } : null;
  const crypto = () => {
    const server = new FakeCryptoServer();
    return {
      app: { cipher: server.cipherFor({ decrypt: ['console-telescope'] }) },
      console: { cipher: server.cipherFor({ encrypt: ['console-telescope'] }) },
    };
  };

  it('a fallback verifier: no token is accepted, a sent token must pass and caps the command', async () => {
    const redis = new FakeRedis();
    const c = crypto();
    const { seen } = await app(redis, { crypto: c.app, verifyAppCaller, partition: 'shop' });
    expect(
      await sender(redis, { crypto: c.console }).send('queues.retry', ['q', '1']),
    ).toMatchObject({
      status: 200,
    });
    expect(seen.at(-1)?.verified).toBeUndefined();
    const withToken = sender(redis, { crypto: c.console, token: async () => 'hub-call' });
    expect(await withToken.send('health', [])).toMatchObject({ status: 200 });
    expect(await withToken.send('queues.retry', ['q', '1'])).toMatchObject({ status: 403 });
    expect(
      await sender(redis, { crypto: c.console, token: async () => 'forged' }).send('health', []),
    ).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
  });

  it("the control plane's own verifyTenant as a fallback: optional too", async () => {
    const redis = new FakeRedis();
    const c = crypto();
    const fallbackVerifyTenant: TenantVerifier = ({ token }) =>
      token === 'ingest' ? { partition: 'shop', capabilities: ['telescope:ingest'] } : null;
    await app(redis, { crypto: c.app, fallbackVerifyTenant, partition: 'shop' });
    expect(await sender(redis, { crypto: c.console }).send('health', [])).toMatchObject({
      status: 200,
    });
    // An ingest token, when sent, caps the command to nothing.
    expect(
      await sender(redis, { crypto: c.console, token: async () => 'ingest' }).send('health', []),
    ).toMatchObject({ status: 403 });
  });
});

describe("the viewer's capabilities (§4b)", () => {
  it('sends what authorize granted, narrowed to the console set; all of it when none', async () => {
    const { viewerConsoleCapabilities } = await import('../../src/federation/answer.js');
    expect(viewerConsoleCapabilities(undefined)).toEqual([...ALL_CONSOLE_COMMAND_CAPABILITIES]);
    expect(
      viewerConsoleCapabilities(['telescope:console:read', 'flags:console:write', 'telescope:*']),
    ).toEqual(['telescope:console:read', 'telescope:*']);
    expect(viewerConsoleCapabilities([])).toEqual([]);
  });
});

describe('console capability aliases (§10.4)', () => {
  it('the shared matcher: write implies read, literal aliases, look-alikes grant nothing', async () => {
    const { telescopeConsoleAllows: allows, viewerConsoleCapabilities } = await import(
      '../../src/federation/answer.js'
    );
    const write = ['telescope:console:write'];
    expect(allows(write, 'telescope:console:queues')).toBe(true);
    expect(allows(write, 'telescope:console:replay')).toBe(true);
    expect(allows(write, 'telescope:console:read')).toBe(true);
    expect(allows(['telescope:console:read'], 'telescope:console:queues')).toBe(false);
    for (const alias of ['*', 'telescope:*', 'telescope:console:*']) {
      expect(allows([alias], 'telescope:console:replay')).toBe(true);
    }
    // Look-alikes: a `*` anywhere but a whole last segment, or another namespace, grants nothing.
    for (const lookAlike of [
      'telescope:console:q*',
      'telescope:c*',
      'telescope:*:queues',
      '*:console:*',
      'flags:console:*',
      'telescope:console',
      '',
    ]) {
      expect([lookAlike, allows([lookAlike], 'telescope:console:queues')]).toEqual([
        lookAlike,
        false,
      ]);
    }
    expect(viewerConsoleCapabilities(['telescope:console:*'], 'read')).toEqual([
      'telescope:console:read',
    ]);
    expect(viewerConsoleCapabilities(undefined, 'read')).toEqual(['telescope:console:read']);
    expect(
      viewerConsoleCapabilities(['telescope:c*', 'flags:*', 'telescope:console:read']),
    ).toEqual(['telescope:console:read']);
  });

  it('a token holding telescope:console:write runs actions over the channel', async () => {
    const redis = new FakeRedis();
    const keys = consoleCommandKeys(APP_KEY, 'shop');
    const verifyTenant: TenantVerifier = () => ({
      partition: 'shop',
      capabilities: ['telescope:console:read', 'telescope:console:write'],
    });
    const { ran } = await app(redis, { keys, verifyTenant, partition: 'shop' });
    const s = sender(redis, { token: async () => 't', publicKey: keys.publicKey });
    expect(await s.send('queues.retry', ['q', '1'])).toMatchObject({ status: 200 });
    expect(await s.send('replay', ['e1'])).toMatchObject({ status: 200 });
    expect(ran).toEqual(['queues.retry', 'replay']);
  });
});

describe('the order of checks (§10.18)', () => {
  it('verb, then capabilities, then the token', async () => {
    const redis = new FakeRedis();
    const keys = consoleCommandKeys(APP_KEY, 'shop');
    const verifyTenant: TenantVerifier = () => null;
    const { ran } = await answerWithVerbs(redis, keys, verifyTenant);
    const forged = new ConsoleCommandSender(redis.client(), {
      app: 'shop',
      prefix: 'shop',
      token: async () => 'bad',
      publicKey: keys.publicKey,
    });
    stops.push(() => forged.close());
    expect(await forged.send('nope', [], undefined, { capabilities: ['*'] })).toMatchObject({
      ok: false,
      error: { code: 'unsupported-request' },
    });
    expect(await forged.send('health', [])).toMatchObject({
      ok: true,
      status: 403,
      body: { code: CAPABILITIES_REQUIRED },
    });
    expect(await forged.send('health', [], undefined, { capabilities: ['*'] })).toMatchObject({
      ok: false,
      error: { code: UNAUTHORIZED_CONSOLE },
    });
    expect(ran).toEqual([]);
  });
});

async function answerWithVerbs(
  redis: FakeRedis,
  keys: ReturnType<typeof consoleCommandKeys>,
  verifyTenant: TenantVerifier,
) {
  const ran: string[] = [];
  const { CONSOLE_COMMAND_VERBS } = await import('../../src/federation/answer.js');
  stops.push(
    await answerConsoleCommands(
      redis.client(),
      async (command) => {
        ran.push(command.verb);
        return { status: 200, body: null };
      },
      {
        prefix: 'shop',
        keys,
        verifyTenant,
        partition: 'shop',
        verbs: Object.keys(CONSOLE_COMMAND_VERBS),
      },
    ),
  );
  return { ran };
}

describe('replayed (§11b): only the instance that ran the id says so', () => {
  async function instances(redis: FakeRedis, count: number) {
    const ran: string[] = [];
    const reasons: string[][] = [];
    for (let i = 0; i < count; i += 1) {
      const mine: string[] = [];
      reasons.push(mine);
      stops.push(
        await answerConsoleCommands(
          redis.client(),
          async (command) => {
            ran.push(`${i}:${command.verb}`);
            return { status: 200, body: null };
          },
          {
            prefix: 'shop',
            instanceId: `i${i}`,
            secret: SECRET,
            onError: (message) => mine.push(message),
          },
        ),
      );
    }
    return { ran, reasons };
  }

  it('losing the claim to another instance is silent', async () => {
    const redis = new FakeRedis();
    const { ran, reasons } = await instances(redis, 3);
    expect(await sender(redis, { secret: SECRET }).send('health', [])).toMatchObject({
      status: 200,
    });
    await tick(20);
    expect(ran).toHaveLength(1);
    expect(reasons.flat()).toEqual([]);
  });

  it('a replay of a command this instance ran is logged as replayed, by that instance only', async () => {
    const redis = new FakeRedis();
    const { ran, reasons } = await instances(redis, 2);
    await sender(redis, { secret: SECRET }).send('health', []);
    const wire = redis.published.find((p) => p.channel === channels.commands)?.message as string;
    await publish(redis, wire);
    await tick(30);
    expect(ran).toHaveLength(1);
    const winner = Number((ran[0] as string).split(':')[0]);
    expect(reasons[winner]).toEqual(['replayed']);
    expect(reasons[1 - winner]).toEqual([]);
  });
});
