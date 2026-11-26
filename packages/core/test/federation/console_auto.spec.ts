import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeProvider from '../../providers/telescope_provider.js';
import TelescopeUiProvider from '../../providers/telescope_ui_provider.js';
import { defineConfig } from '../../src/define_config.js';
import {
  consoleCommandsDoctorCheck as check,
  consoleCommandsDoctorCheck as consoleCommandsCheck,
  consoleCommandsKeyDoctorCheck as keyCheck,
} from '../../src/doctor/console_commands_check.js';
import { CONSOLE_CRYPTO_KEY } from '../../src/federation/console_commands.js';
import type { FederatedApp, Federation } from '../../src/federation/federation.js';
import { resetTelescopeRuntime } from '../../src/registry.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { FakeRedis } from './fake_redis.js';

/**
 * Zero configuration when the libs are together: the providers find `@adonis-agora/crypto`
 * (`agora.crypto`) and `@adonis-agora/authkit-client` (`authkit.client`) in the container and
 * use them, through the real boot path. Both are fakes with the shapes those libs bind.
 */

class CryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A crypto server: keys per partition, an audit of who did what where. */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>();
  readonly audit: string[] = [];
  /** Whether a tenant's client may create keys (`crypto:keys:manage:console-*`). */
  tenantMayManage = true;
  /** Embedded `createKey` calls that fail before one succeeds (crypto's database down at boot). */
  failCreates = 0;

  #seal(partition: string, key: string, plaintext: string, aad?: string) {
    const material = this.keys.get(`${partition}/${key}`);
    if (!material) throw new CryptoError('not_found', `crypto: no key named "${key}"`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', material, iv);
    cipher.setAAD(Buffer.from(aad ?? ''));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
    };
  }

  #open(partition: string, key: string, ciphertext: string, aad?: string) {
    const material = this.keys.get(`${partition}/${key}`);
    if (!material) throw new CryptoError('not_found', `crypto: no key named "${key}"`);
    const raw = Buffer.from(ciphertext.split(':').pop() as string, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', material, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad ?? ''));
    decipher.setAuthTag(raw.subarray(12, 28));
    return {
      plaintext: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
        'utf8',
      ),
    };
  }

  #create(partition: string, name: string) {
    const id = `${partition}/${name}`;
    if (this.keys.has(id))
      throw new CryptoError('conflict', `crypto: key "${name}" already exists`);
    this.keys.set(id, randomBytes(32));
    this.audit.push(`create ${id}`);
    return { name };
  }

  /** The runtime of the app the crypto server is embedded in (the Hub). */
  embedded(partition: string) {
    const service = {
      encrypt: async (
        p: { partition: string; capabilities: string[] },
        i: { key: string; plaintext: string; aad?: string },
      ) => {
        this.audit.push(`encrypt ${p.partition}/${i.key} [${p.capabilities.join(',')}]`);
        return this.#seal(p.partition, i.key, i.plaintext, i.aad);
      },
      decrypt: async (
        p: { partition: string },
        i: { key: string; ciphertext: string; aad?: string },
      ) => this.#open(p.partition, i.key, i.ciphertext, i.aad),
      createKey: async (p: { partition: string }, i: { name: string }) => {
        if (this.failCreates > 0) {
          this.failCreates -= 1;
          throw new Error('database down');
        }
        return this.#create(p.partition, i.name);
      },
      store: { getKey: async (p: string, name: string) => this.keys.get(`${p}/${name}`) ?? null },
    };
    return {
      topology: 'control-plane' as const,
      partition,
      service,
      operations: {
        encrypt: async (i: { key: string; plaintext: string; aad?: string }) =>
          this.#seal(partition, i.key, i.plaintext, i.aad),
        decrypt: async (i: { key: string; ciphertext: string; aad?: string }) =>
          this.#open(partition, i.key, i.ciphertext, i.aad),
      },
    };
  }

  /** The runtime of a crypto tenant of this server (its own partition). */
  /** Decrypt calls per partition (a key probe that writes to crypto's audit, §13f). */
  readonly decrypts: string[] = [];

  tenant(
    partition: string,
    options: {
      mayDecrypt?: boolean;
      /** §13f: `true` a current crypto server, `'old'` one that lacks it, `'forbidden'` refusing. */
      hasKey?: true | 'old' | 'forbidden';
    } = {},
  ) {
    const hasKey =
      options.hasKey === undefined
        ? {}
        : {
            hasKey: async ({ key }: { key: string }) => {
              if (options.hasKey === 'old') throw new Error('404 Not Found');
              if (options.hasKey === 'forbidden') {
                throw new CryptoError('forbidden', `crypto: needs crypto:decrypt:${key}`);
              }
              return this.keys.has(`${partition}/${key}`);
            },
          };
    return {
      topology: 'tenant' as const,
      partition,
      operations: {
        encrypt: async (i: {
          key: string;
          plaintext: string;
          aad?: string;
          partition?: string;
        }) => {
          // `partition`: seal for another app (crypto:seal:console-*), encrypt only.
          const target = i.partition ?? partition;
          this.audit.push(`seal ${target}/${i.key} by ${partition}`);
          return this.#seal(target, i.key, i.plaintext, i.aad);
        },
        ...hasKey,
        decrypt: async (i: { key: string; ciphertext: string; aad?: string }) => {
          this.decrypts.push(`${partition}/${i.key}`);
          if (options.mayDecrypt === false) {
            throw new CryptoError('forbidden', `crypto: needs crypto:decrypt:${i.key}`);
          }
          return this.#open(partition, i.key, i.ciphertext, i.aad);
        },
        getKey: async (name: string) => {
          if (!this.keys.has(`${partition}/${name}`)) {
            throw new CryptoError('not_found', `crypto: no key named "${name}"`);
          }
          return { name };
        },
        createKey: async (i: { name: string }) => {
          if (!this.tenantMayManage) {
            throw new CryptoError('forbidden', `crypto: needs crypto:keys:manage:${i.name}`);
          }
          return this.#create(partition, i.name);
        },
      },
    };
  }
}

/** An authkit client with calls between apps: tokens for other apps, a verifier for its own. */
function fakeAuthkit(self: string, grants: Record<string, string[]>) {
  const issued: string[] = [];
  return {
    issued,
    client: {
      appCallTokens: () => ({
        token: async (app: string) => {
          issued.push(app);
          return `app-call:${self}->${app}`;
        },
        reset: () => {},
      }),
      appCallerVerifier: () => ({
        verifyToken: async (token: string) => {
          const match = /^app-call:([^-]+)->(.+)$/.exec(token);
          if (!match || match[2] !== self) return null;
          return {
            app: match[1] as string,
            capabilities: grants[match[1] as string] ?? [],
            clientId: `${match[1]}-client`,
            expiresAt: Date.now() + 60_000,
          };
        },
      }),
    },
  };
}

function fakeApp(
  config: Record<string, unknown>,
  options: { environment?: string; bindings?: Record<string, unknown> } = {},
) {
  const logs: Array<{ level: string; message: string }> = [];
  const logger = Object.fromEntries(
    ['warn', 'debug', 'info', 'error'].map((level) => [
      level,
      (message: string) => logs.push({ level, message }),
    ]),
  );
  const bindings = options.bindings ?? {};
  const app = {
    inProduction: false,
    getEnvironment: () => options.environment ?? 'web',
    appRoot: new URL('../../', import.meta.url),
    config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
    container: {
      hasBinding: (key: string) => key in bindings,
      bindValue: () => {},
      singleton: () => {},
      make: async (key: string) => {
        if (key in bindings) return bindings[key];
        if (key === 'router')
          return { post: () => ({ as: () => {} }), get: () => ({ as: () => {} }) };
        if (key === 'logger') return logger;
        return undefined;
      },
    },
  };
  return { app: app as unknown as ApplicationService, logs };
}

const quiet = { overload: { enabled: false }, watchers: [] as never[], fleet: false as const };
const APP_KEY = 'app-key-of-the-shop-0123456789';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetTelescopeRuntime();
  vi.restoreAllMocks();
});

/** The owning app (the shop): boots telescope with `consoleCommands`, answers on `redis`. */
async function bootShop(
  redis: FakeRedis,
  consoleCommands: Record<string, unknown> | undefined,
  options: { environment?: string; bindings?: Record<string, unknown>; telescope?: object } = {},
) {
  const fake = fakeApp(
    {
      telescope: defineConfig({
        ...quiet,
        ...(options.telescope ?? {}),
        ...(consoleCommands !== undefined
          ? { consoleCommands: { client: redis.client(), prefix: 'shop', ...consoleCommands } }
          : {}),
      } as never),
      'app.appKey': APP_KEY,
    },
    options,
  );
  const provider = new TelescopeProvider(fake.app);
  provider.register();
  cleanups.push(() => provider.shutdown());
  await provider.boot();
  await provider.ready();
  return { ...fake, provider };
}

/** The console (the Hub): its UI provider with the shop federated. */
async function bootHub(
  redis: FakeRedis,
  /** `undefined`: the entry omits `commands` (on by default). */
  commands: Record<string, unknown> | false | undefined,
  options: {
    environment?: string;
    bindings?: Record<string, unknown>;
    partition?: string;
    /** More federated entries, as given. */
    others?: Record<string, unknown>;
  } = {},
) {
  const fake = fakeApp(
    {
      telescope: {},
      telescope_ui: {
        authorize: () => true,
        apps: {
          federated: {
            shop: {
              store: { list: async () => [], get: async () => null } as never,
              ...(options.partition !== undefined ? { partition: options.partition } : {}),
              ...(commands === undefined
                ? {}
                : {
                    commands:
                      commands === false
                        ? false
                        : { client: redis.client(), prefix: 'shop', ...commands },
                  }),
              timeoutMs: 1_000,
            },
            ...(options.others ?? {}),
          },
        },
      },
    },
    options,
  );
  const { setTelescopeRuntime } = await import('../../src/registry.js');
  const { InMemoryTelescopeStore } = await import('../../src/stores/memory.js');
  setTelescopeRuntime(new InMemoryTelescopeStore(), true);
  const provider = new TelescopeUiProvider(fake.app);
  cleanups.push(() => provider.shutdown());
  await provider.boot();
  const federation = (provider as unknown as { federation: Federation | null }).federation;
  return { ...fake, provider, shop: federation?.get('shop') as FederatedApp };
}

describe('automatic crypto mode: nothing to configure', () => {
  it('Hub with crypto embedded, app a crypto tenant: the key is created, commands sealed', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    const hub = await bootHub(redis, {}, { bindings: { 'agora.crypto': crypto.embedded('hub') } });
    // The Hub created the key in the shop's partition (its federated key by default).
    expect(crypto.keys.has(`shop/${CONSOLE_CRYPTO_KEY}`)).toBe(true);
    expect(hub.logs).toContainEqual({
      level: 'info',
      message:
        '[@adonis-agora/telescope] console commands: created the crypto key "console-telescope" in partition shop',
    });
    expect(hub.logs.map((l) => l.message).join('\n')).toContain(
      'console commands to "shop": crypto (auto, key console-telescope, partition shop)',
    );
    const shop = await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    expect(shop.logs.map((l) => l.message)).toContain(
      '[@adonis-agora/telescope] console commands: crypto (auto, key console-telescope); actions off (set consoleCommands.actions.replay or consoleCommands.actions.queues to let the console act)',
    );

    const reply = await hub.shop.run('health', []);
    expect(reply.status).toBeLessThan(500);
    expect(crypto.audit).toContain(
      'encrypt shop/console-telescope [crypto:encrypt:console-telescope]',
    );
    // Nothing readable on Redis.
    expect(redis.published.map((p) => p.message).join('\n')).not.toContain('"verb"');
  });

  it('the federated partition can differ from the key; the app creates its own key as a tenant', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    const shop = await bootShop(
      redis,
      {},
      { bindings: { 'agora.crypto': crypto.tenant('shop-prod') } },
    );
    expect(crypto.audit).toContain('create shop-prod/console-telescope');
    expect(shop.logs.filter((l) => l.level === 'warn')).toEqual([]);
    const hub = await bootHub(
      redis,
      {},
      { bindings: { 'agora.crypto': crypto.embedded('hub') }, partition: 'shop-prod' },
    );
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
  });

  it('a Hub that is itself a crypto tenant seals for the app through its crypto server', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    const hub = await bootHub(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('hub') } });
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(crypto.audit).toContain('seal shop/console-telescope by hub');
  });

  it('a tenant whose key is missing logs one info line: the server provisions it', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    crypto.tenantMayManage = false;
    const shop = await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shop.logs.filter((l) => l.level === 'warn')).toEqual([]);
    const notes = shop.logs.filter((l) => l.message.includes('does not exist in partition shop'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ level: 'info' });
    expect(notes[0]?.message).toContain("creates it on the console's first command");
    expect(notes[0]?.message).toContain(
      'node ace crypto:keys:create console-telescope --type aes256-gcm --application shop',
    );
  });

  it('explicit options win: a secret is used as given, no crypto on top', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    const secret = 'a-shared-secret-of-the-shop';
    const shop = await bootShop(
      redis,
      { secret },
      { bindings: { 'agora.crypto': crypto.tenant('shop') } },
    );
    expect(shop.logs.map((l) => l.message)).toContain(
      '[@adonis-agora/telescope] console commands: secret; actions off (set consoleCommands.actions.replay or consoleCommands.actions.queues to let the console act)',
    );
    expect(crypto.keys.size).toBe(0);
    const hub = await bootHub(
      redis,
      { secret },
      { bindings: { 'agora.crypto': crypto.embedded('hub') } },
    );
    expect(hub.shop.authMode).toBe('secret');
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(crypto.audit).toEqual([]);
  });
});

describe('misconfiguration fails at boot', () => {
  it('an app with consoleCommands and no way to authenticate refuses to boot (web only)', async () => {
    const redis = new FakeRedis();
    await expect(bootShop(redis, {})).rejects.toThrow(
      "[@adonis-agora/telescope] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key console-telescope), or configure authkit-client's `service` (automatic: the console uses an authkit app-call token; grant it telescope:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). Run `node ace agora:doctor` to see every Agora lib's console auth at once. Docs: https://davidecarvalho.github.io/agora/docs/telescope/concepts/federated-console#authenticating-the-console",
    );
    // An ace command never starts the channel, and is left alone.
    await expect(bootShop(redis, {}, { environment: 'console' })).resolves.toBeDefined();
  });

  it('crypto: false turns the automatic mode off', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    await expect(
      bootShop(redis, { crypto: false }, { bindings: { 'agora.crypto': crypto.tenant('shop') } }),
    ).rejects.toThrow(/consoleCommands needs authentication/);
    await expect(
      bootHub(redis, { crypto: false }, { bindings: { 'agora.crypto': crypto.embedded('hub') } }),
    ).rejects.toThrow(/apps\.federated\["shop"\]: commands to this app need authentication/);
  });

  it('a console with a federated app it cannot authenticate to refuses to boot; commands: false browses', async () => {
    const redis = new FakeRedis();
    await expect(bootHub(redis, {})).rejects.toThrow(
      /apps\.federated\["shop"\]: commands to this app need authentication.*commands: false to only browse it\. Run `node ace agora:doctor`/,
    );
    // A token alone cannot travel: it needs crypto or the app's public key.
    await expect(bootHub(redis, { token: 'x' })).rejects.toThrow(/need authentication/);
    await expect(bootHub(redis, false)).resolves.toBeDefined();
    await expect(bootHub(redis, {}, { environment: 'console' })).resolves.toBeDefined();
  });
});

describe("the control plane's own verifyTenant (fallback)", () => {
  const verifyTenant = sharedSecretVerifier({
    partitions: { shop: 'shop-ingest-secret' },
  });
  const control = { topology: 'control-plane', verifyTenant };

  it('stands in for consoleCommands.verifyTenant, and an ingest token runs nothing', async () => {
    const redis = new FakeRedis();
    const shop = await bootShop(redis, {}, { telescope: control });
    expect(shop.logs.map((l) => l.message).join('\n')).toContain(
      "token (the control plane's verifyTenant; sealed to key ",
    );
    const { consoleCommandKeys } = await import('../../src/federation/console_commands.js');
    const hub = await bootHub(redis, {
      // A tenant's ingest token (telescope:ingest), lifted and replayed as a console token.
      token: 'shop-ingest-secret',
      publicKey: consoleCommandKeys(APP_KEY, 'shop').publicKey,
    });
    const reply = await hub.shop.run('health', []);
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).toContain('lacks telescope:console:read');
  });

  it('verifyTenant: false turns the fallback off', async () => {
    const redis = new FakeRedis();
    await expect(bootShop(redis, { verifyTenant: false }, { telescope: control })).rejects.toThrow(
      /consoleCommands needs authentication/,
    );
  });
});

describe('automatic token from authkit (calls between apps)', () => {
  it('with crypto too: the command is sealed and carries an app-call token the app verifies', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    const shopAuthkit = fakeAuthkit('shop', { hub: ['telescope:console:read'] });
    const hubAuthkit = fakeAuthkit('hub', {});
    const shop = await bootShop(
      redis,
      { actions: { queues: true } },
      {
        bindings: { 'agora.crypto': crypto.tenant('shop'), 'authkit.client': shopAuthkit.client },
      },
    );
    // Sealed with crypto, or (with an APP_KEY) to the app's own key: either way with the token.
    expect(shop.logs.map((l) => l.message)).toContainEqual(
      expect.stringMatching(
        /^\[@adonis-agora\/telescope\] console commands: crypto \(auto, key console-telescope\) \+ token checked when sent \(authkit app-call, auto\) \+ token \(authkit app-call, auto; sealed to key [0-9a-f]{8}\); actions on$/,
      ),
    );
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': hubAuthkit.client },
      },
    );
    expect(hub.shop.authMode).toBe(
      'crypto (auto, key console-telescope, partition shop) + token (authkit app-call, auto)',
    );
    // Allowed: authkit granted the Hub telescope:console:read on the shop. The token's partition
    // is the Hub (the caller), which is fine: its audience binds it to the shop.
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(hubAuthkit.issued).toEqual(['shop']);
    // Not granted: queues (even though the app allows them and the viewer may).
    const retry = await hub.shop.run('queues.retry', ['emails', '1']);
    expect(retry.status).toBe(403);
    expect(JSON.stringify(retry.body)).toContain('token lacks telescope:console:queues');
  });

  it('a crypto console without a token is accepted (§2c): the key authenticates it', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    await bootShop(
      redis,
      {},
      {
        bindings: {
          'agora.crypto': crypto.tenant('shop'),
          'authkit.client': fakeAuthkit('shop', { hub: ['*'] }).client,
        },
      },
    );
    const hub = await bootHub(
      redis,
      { token: false },
      { bindings: { 'agora.crypto': crypto.embedded('hub') } },
    );
    const reply = await hub.shop.run('health', []);
    expect(reply.status).toBeLessThan(500);
  });
});

describe('agora:doctor telescope.console-commands', () => {
  const run = (
    config: Record<string, unknown>,
    bindings: Record<string, unknown> = {},
    which: typeof check = check,
  ) => which.run(fakeApp({ 'app.appKey': APP_KEY, ...config }, { bindings }).app);

  it('skips when nothing is federated', async () => {
    expect(await run({})).toMatchObject({ status: 'skip' });
  });

  it('errors when an app side or a console side cannot authenticate', async () => {
    expect(await run({ telescope: { consoleCommands: {} } })).toEqual([
      expect.objectContaining({
        status: 'error',
        fix: expect.stringContaining('@adonis-agora/crypto'),
      }),
    ]);
    expect(
      await run({ telescope_ui: { apps: { federated: { shop: { store: {}, commands: {} } } } } }),
    ).toEqual([
      expect.objectContaining({ status: 'error', fix: expect.stringContaining('commands: false') }),
    ]);
  });

  it('probes the key in automatic crypto mode on both sides', async () => {
    const crypto = new FakeCryptoServer();
    const hub = crypto.embedded('hub');
    const config = {
      telescope: { consoleCommands: {} },
      telescope_ui: { apps: { federated: { shop: { store: {}, commands: {} } } } },
    };
    // Missing keys: the app's own (embedded) and the shop's.
    const missing = (await run(config, { 'agora.crypto': hub }, keyCheck)) as Array<{
      status: string;
    }>;
    expect(missing.map((r) => r.status)).toEqual(['warn', 'warn']);
    await hub.service.createKey({ partition: 'hub' }, { name: CONSOLE_CRYPTO_KEY });
    await hub.service.createKey({ partition: 'shop' }, { name: CONSOLE_CRYPTO_KEY });
    const ok = (await run(config, { 'agora.crypto': hub }, keyCheck)) as Array<{
      status: string;
      message: string;
    }>;
    expect(ok.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(ok[0]?.message).toContain('crypto (auto, key console-telescope)');
    // A tenant app whose client may not decrypt.
    const tenant = crypto.tenant('shop', { mayDecrypt: false });
    const denied = (await run(
      { telescope: { consoleCommands: {} } },
      { 'agora.crypto': tenant },
      keyCheck,
    )) as Array<{
      status: string;
      fix?: string;
    }>;
    expect(denied[0]).toMatchObject({
      status: 'error',
      fix: expect.stringContaining('needs no grant'),
    });
  });
});

describe('planAppAuth (§10.5)', () => {
  it('keeps the APP_KEY-sealed token mode alongside crypto when a verifier and an APP_KEY exist', async () => {
    const { planAppAuth } = await import('../../src/federation/auto_crypto.js');
    const context = {
      cryptoBound: true,
      authkitBound: false,
      appKey: true,
      appName: 'shop',
      controlPlaneVerifier: false,
      keyId: 'key 1234abcd',
    };
    expect(planAppAuth({ crypto: { key: 'k' }, verifyTenant: () => null }, context).modes).toEqual([
      'crypto (key k)',
      'token required (verifyTenant)',
      'token (verifyTenant; sealed to key 1234abcd)',
    ]);
    // On a control plane the fallback applies by default (the partition defaults too), even with
    // explicit crypto; only an explicit verifyTenant (or false) suppresses it.
    const plane = { ...context, controlPlaneVerifier: true };
    expect(planAppAuth({ crypto: { key: 'k' } }, plane).keys).toBe(true);
    expect(planAppAuth({ crypto: { key: 'k' }, verifyTenant: false }, plane).keys).toBe(false);
  });
});

describe('review round 2', () => {
  it('an embedded key that fails at boot is retried on the first command, with the exact line', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    crypto.failCreates = 1;
    const hub = await bootHub(redis, {}, { bindings: { 'agora.crypto': crypto.embedded('hub') } });
    expect(hub.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      expect.stringContaining(
        '`node ace crypto:keys:create console-telescope --type aes256-gcm --application shop` (retried on the first command)',
      ),
    ]);
    expect(crypto.keys.has(`shop/${CONSOLE_CRYPTO_KEY}`)).toBe(false);
    await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    // The shop created its own key meanwhile; the Hub's retry then finds it.
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
  });

  it('a tenant refused on its key logs one actionable line (no getKey)', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    const shop = await bootShop(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.tenant('shop', { mayDecrypt: false }) },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shop.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      expect.stringContaining("no grant is needed for an app's own console keys"),
    ]);
  });

  it('an authkit binding without calls between apps configured is not a mode (boot error)', async () => {
    const redis = new FakeRedis();
    const unconfigured = { appCallTokens: () => undefined, appCallerVerifier: () => null };
    await expect(
      bootShop(redis, { crypto: false }, { bindings: { 'authkit.client': unconfigured } }),
    ).rejects.toThrow(/consoleCommands needs authentication/);
    const crypto = new FakeCryptoServer();
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': unconfigured },
      },
    );
    // No usable token source: crypto alone, no token promised.
    expect(hub.shop.authMode).toBe('crypto (auto, key console-telescope, partition shop)');
  });

  it('browse-only federated apps get a boot line too', async () => {
    const hub = await bootHub(new FakeRedis(), false);
    expect(hub.logs.map((l) => l.message)).toContain(
      '[@adonis-agora/telescope] console commands to "shop": none (browse-only, commands: false)',
    );
  });
});

describe('commands is on by default (§10.9)', () => {
  const store = { list: async () => [], get: async () => null };

  it('an entry without `commands` sends actions on the default channel, zero config', async () => {
    const redis = new FakeRedis();
    const crypto = new FakeCryptoServer();
    // The app with its defaults: prefix `telescope`.
    await bootShop(
      redis,
      { prefix: 'telescope' },
      {
        bindings: { 'agora.crypto': crypto.tenant('shop') },
      },
    );
    const hub = await bootHub(redis, undefined, {
      bindings: {
        'agora.crypto': crypto.embedded('hub'),
        redis: { connection: () => redis.client() },
      },
    });
    expect(hub.shop.actions).toBe('app');
    expect(hub.shop.authMode).toBe('crypto (auto, key console-telescope, partition shop)');
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
  });

  it('an entry without `commands` that cannot authenticate is a boot error', async () => {
    await expect(bootHub(new FakeRedis(), undefined)).rejects.toThrow(
      /apps\.federated\["shop"\]: commands to this app need authentication.*commands: false/,
    );
  });

  it('several entries without `commands`: browse-only, each with a boot line saying how', async () => {
    const crypto = new FakeCryptoServer();
    const hub = await bootHub(new FakeRedis(), undefined, {
      bindings: { 'agora.crypto': crypto.embedded('hub') },
      others: { billing: { store } },
    });
    expect(hub.shop.actions).toBe('none');
    const lines = hub.logs.map((l) => l.message).filter((m) => m.includes('browse-only'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      "set apps.federated.shop.commands to { prefix: '<its consoleCommands.prefix>' }",
    );
  });
});

describe('never crash on a bad message (§11)', () => {
  it('garbage on the command channel is logged once per reason and dropped; the app keeps serving', async () => {
    const redis = new FakeRedis();
    const secret = 'a-shared-secret-of-the-shop';
    const shop = await bootShop(redis, { secret });
    const { consoleChannels } = await import('../../src/federation/console_commands.js');
    const channel = consoleChannels('shop').commands;
    const garbage = [
      'not json at all',
      'not json at all',
      'null',
      '42',
      '{"id":1}',
      '{"id":"x","sealed":"agora:pk1:garbage"}',
      '{"id":"y","sealed":"agora:ct1:console-telescope:1:AAAA"}',
      '{"id":"z","verb":"health","mac":"forged","ts":0}',
      JSON.stringify({ id: 'w', verb: { toString: null }, args: 'nope', mac: 1 }),
    ];
    for (const message of garbage) await redis.client().call('PUBLISH', channel, message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const hub = await bootHub(redis, { secret });
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    const refusals = shop.logs
      .filter((l) => l.level === 'warn')
      .map((l) => l.message)
      .filter((m) => m.includes('console commands: refused a command ('));
    // Each reason once (the two identical non-JSON messages give one line).
    expect(new Set(refusals).size).toBe(refusals.length);
    // The uniform reasons (§11b), never "(unsigned?)".
    for (const reason of [
      'not JSON',
      'no command id',
      'bad signature',
      'mode not accepted here (this app accepts: secret; the command came as token)',
      'mode not accepted here (this app accepts: secret; the command came as crypto)',
    ]) {
      expect(refusals).toContain(
        `[@adonis-agora/telescope] console commands: refused a command (${reason})`,
      );
    }
    expect(refusals.join('\n')).not.toContain('unsigned?');
  });
});

describe('boot errors say why the automatic modes did not apply (§11 Note)', () => {
  it('app side: crypto: false, and a verifier without an APP_KEY', async () => {
    const crypto = new FakeCryptoServer();
    await expect(
      bootShop(
        new FakeRedis(),
        { crypto: false },
        {
          bindings: { 'agora.crypto': crypto.tenant('shop') },
        },
      ),
    ).rejects.toThrow(
      /Docs: https:\/\/\S+ Note: `crypto: false` turned the automatic crypto mode off\.$/,
    );
    const { planAppAuth, appUnauthenticatedMessage } = await import(
      '../../src/federation/auto_crypto.js'
    );
    const plan = planAppAuth(
      { verifyTenant: () => null },
      {
        cryptoBound: false,
        authkitBound: false,
        appKey: false,
        appName: 'shop',
        controlPlaneVerifier: false,
      },
    );
    expect(plan.modes).toEqual([]);
    expect(appUnauthenticatedMessage(plan.notes)).toMatch(
      / Note: a token verifier is available \(verifyTenant\), but token mode needs an APP_KEY/,
    );
  });

  it('console side: the real entry path, crypto: false and token: false', async () => {
    const crypto = new FakeCryptoServer();
    await expect(
      bootHub(
        new FakeRedis(),
        { crypto: false, token: false },
        {
          bindings: { 'agora.crypto': crypto.embedded('hub') },
        },
      ),
    ).rejects.toThrow(
      'apps.federated["shop"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set apps.federated["shop"].commands.secret, or apps.federated["shop"].commands.token — or commands: false to only browse it. Run `node ace agora:doctor` to see every Agora lib\'s console auth at once. Note: `crypto: false` turned the automatic crypto mode off; `token: false` turned the automatic authkit token off.',
    );
  });
});

describe('the console-side auto-crypto label carries the partition (§11)', () => {
  it('in the doctor too, never on the app side', async () => {
    const crypto = new FakeCryptoServer();
    const result = (await consoleCommandsCheck.run(
      fakeApp(
        {
          'app.appKey': APP_KEY,
          telescope: { consoleCommands: {} },
          telescope_ui: {
            apps: { federated: { shop: { store: {}, commands: {}, partition: 'shop-prod' } } },
          },
        },
        { bindings: { 'agora.crypto': crypto.embedded('hub') } },
      ).app,
    )) as Array<{ message: string }>;
    expect(result.map((r) => r.message)).toEqual([
      '[@adonis-agora/telescope] console commands: crypto (auto, key console-telescope); actions off (set consoleCommands.actions.replay or consoleCommands.actions.queues to let the console act)',
      '[@adonis-agora/telescope] console commands to "shop": crypto (auto, key console-telescope, partition shop-prod)',
    ]);
  });
});

describe('the doctor on a crypto tenant (§2e)', () => {
  it('a missing key is ok with a note: the server provisions it on the first seal', async () => {
    const crypto = new FakeCryptoServer();
    const result = (await keyCheck.run(
      fakeApp(
        { 'app.appKey': APP_KEY, telescope: { consoleCommands: {} } },
        { bindings: { 'agora.crypto': crypto.tenant('shop') } },
      ).app,
    )) as Array<{ status: string; message: string }>;
    expect(result).toEqual([
      expect.objectContaining({
        status: 'ok',
        message: expect.stringContaining("creates it on the console's first command"),
      }),
    ]);
  });
});

describe("authkit's key directory (§2e.B)", () => {
  /** A fake authkit key directory shared by the two apps, recording what was published. */
  function directory() {
    const keys = new Map<string, Record<string, unknown>>();
    const lookups: string[] = [];
    const manager = (self: string, grants: Record<string, string[]>) => ({
      ...fakeAuthkit(self, grants).client,
      publishAppKey: async ({
        purpose,
        jwk,
      }: {
        purpose: string;
        jwk: Record<string, unknown>;
      }) => {
        keys.set(`${self}/${purpose}`, jwk);
      },
      appKey: async ({ app, purpose }: { app: string; purpose: string }) => {
        lookups.push(`${app}/${purpose}`);
        return (keys.get(`${app}/${purpose}`) as never) ?? null;
      },
    });
    return { keys, lookups, manager };
  }

  it('the app publishes its public key; the console seals to it with no publicKey and no crypto', async () => {
    const redis = new FakeRedis();
    const dir = directory();
    await bootShop(
      redis,
      {},
      {
        bindings: { 'authkit.client': dir.manager('shop', { hub: ['telescope:console:read'] }) },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const published = dir.keys.get('shop/console:telescope');
    expect(published).toMatchObject({ kty: 'OKP', crv: 'X25519', use: 'enc' });
    expect(published).not.toHaveProperty('d');
    const hub = await bootHub(
      redis,
      {},
      { bindings: { 'authkit.client': dir.manager('hub', {}) } },
    );
    expect(hub.shop.authMode).toBe(
      'token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(dir.lookups).toContain('shop/console:telescope');
  });

  it('an explicit publicKey wins over the directory', async () => {
    const redis = new FakeRedis();
    const dir = directory();
    await bootShop(
      redis,
      {},
      { bindings: { 'authkit.client': dir.manager('shop', { hub: ['*'] }) } },
    );
    const { consoleCommandKeys } = await import('../../src/federation/console_commands.js');
    const hub = await bootHub(
      redis,
      { publicKey: consoleCommandKeys(APP_KEY, 'shop').publicKey },
      { bindings: { 'authkit.client': dir.manager('hub', {}) } },
    );
    expect(hub.shop.authMode).toBe("token (authkit app-call, auto; sealed to the app's publicKey)");
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(dir.lookups).toEqual([]);
  });

  it('an app that never published: the command fails with the actionable error', async () => {
    const dir = directory();
    const hub = await bootHub(
      new FakeRedis(),
      {},
      {
        bindings: { 'authkit.client': dir.manager('hub', {}) },
      },
    );
    const reply = await hub.shop.run('health', []);
    expect(reply.status).toBe(503);
    expect(JSON.stringify(reply.body)).toContain(
      "has no console key in authkit's key directory (purpose console:telescope). It publishes it automatically at boot in token mode when it has authkit's `service` configured",
    );
  });
});

describe('mixed Hubs (§13)', () => {
  /** A Hub's authkit: app-call tokens (or a failing mint) and a key directory. */
  function hubAuthkit(options: { tokens?: 'ok' | 'fail'; published?: Map<string, unknown> } = {}) {
    const minted: string[] = [];
    const lookups: string[] = [];
    const published = options.published ?? new Map<string, unknown>();
    const base = fakeAuthkit('hub', {}).client;
    return {
      minted,
      lookups,
      published,
      client: {
        ...base,
        appCallTokens: () => ({
          token: async (app: string) => {
            minted.push(app);
            if (options.tokens === 'fail')
              throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
            return `app-call:hub->${app}`;
          },
          reset: () => {},
        }),
        appKey: async ({ app, purpose }: { app: string; purpose: string }) => {
          lookups.push(app);
          return (published.get(`${app}/${purpose}`) as never) ?? null;
        },
      },
    };
  }

  it('13a: a crypto app gets crypto, an authkit-only app gets token mode; no config lines', async () => {
    // ET: a crypto tenant of the Hub, it publishes nothing.
    const crypto = new FakeCryptoServer();
    const etRedis = new FakeRedis();
    await bootShop(etRedis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    const et = hubAuthkit();
    const hubForEt = await bootHub(
      etRedis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': et.client },
      },
    );
    expect(hubForEt.logs.map((l) => l.message)).toContain(
      '[@adonis-agora/telescope] console commands to "shop": auto (authkit key directory if the app publishes one, else crypto (auto, key console-telescope, partition shop))',
    );
    expect((await hubForEt.shop.run('health', [])).status).toBeLessThan(500);
    expect(crypto.audit).toContain(
      'encrypt shop/console-telescope [crypto:encrypt:console-telescope]',
    );

    // EduLiberta: authkit only (no crypto); it publishes its key, so the Hub uses token mode.
    const elRedis = new FakeRedis();
    const published = new Map<string, unknown>();
    const elAuthkit = {
      ...fakeAuthkit('shop', { hub: ['telescope:console:read'] }).client,
      publishAppKey: async ({ purpose, jwk }: { purpose: string; jwk: unknown }) => {
        published.set(`shop/${purpose}`, jwk);
      },
    };
    await bootShop(elRedis, {}, { bindings: { 'authkit.client': elAuthkit } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const el = hubAuthkit({ published });
    const hubForEl = await bootHub(
      elRedis,
      {},
      {
        bindings: {
          'agora.crypto': new FakeCryptoServer().embedded('hub'),
          'authkit.client': el.client,
        },
      },
    );
    expect((await hubForEl.shop.run('health', [])).status).toBeLessThan(500);
    expect(el.minted).toEqual(['shop']);
  });

  it('13a: the choice is cached, and made again after 5 minutes', async () => {
    const crypto = new FakeCryptoServer();
    const redis = new FakeRedis();
    await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    const authkit = hubAuthkit();
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': authkit.client },
      },
    );
    await hub.shop.run('health', []);
    await hub.shop.run('health', []);
    expect(authkit.lookups).toEqual(['shop']);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    await hub.shop.run('health', []);
    expect(authkit.lookups).toEqual(['shop', 'shop']);
  });

  it('13b: in crypto mode a token that cannot be minted never blocks the command', async () => {
    const crypto = new FakeCryptoServer();
    const redis = new FakeRedis();
    await bootShop(
      redis,
      {},
      {
        bindings: {
          'agora.crypto': crypto.tenant('shop'),
          'authkit.client': fakeAuthkit('shop', { hub: ['*'] }).client,
        },
      },
    );
    const authkit = hubAuthkit({ tokens: 'fail' });
    const { appKey: _directory, ...noDirectory } = authkit.client;
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': noDirectory },
      },
    );
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    // Logged once, and minting is retried only after 5 minutes.
    // A missing grant is only `info` (§13b): crypto works without the token.
    expect(hub.logs.filter((l) => l.message.includes('sending without'))).toEqual([
      {
        level: 'info',
        message:
          '[@adonis-agora/telescope] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client telescope:console:* on "shop" in authkit.',
      },
    ]);
    expect(authkit.minted).toEqual(['shop']);
  });

  it('13b: in token mode the token is required, and the error names the grant', async () => {
    const published = new Map<string, unknown>([
      ['shop/console:telescope', { kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43) }],
    ]);
    const authkit = hubAuthkit({ tokens: 'fail', published });
    const hub = await bootHub(
      new FakeRedis(),
      {},
      { bindings: { 'authkit.client': authkit.client } },
    );
    const reply = await hub.shop.run('health', []);
    expect(reply.status).toBe(503);
    expect(JSON.stringify(reply.body)).toContain(
      'invalid_target. To attach it: grant the console\'s service client telescope:console:* on \\"shop\\" in authkit.',
    );
  });

  it('13e: an app with crypto does not warn about publishing a key', async () => {
    const crypto = new FakeCryptoServer();
    const { publishAppKey: _p, ...noPublish } = {
      ...fakeAuthkit('shop', {}).client,
      publishAppKey: undefined,
    };
    const shop = await bootShop(
      new FakeRedis(),
      {},
      {
        bindings: { 'agora.crypto': crypto.tenant('shop'), 'authkit.client': noPublish },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shop.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('13f: hasKey checks the key with no decrypt (no audit noise); an old server falls back', async () => {
    const current = new FakeCryptoServer();
    await bootShop(
      new FakeRedis(),
      {},
      {
        bindings: { 'agora.crypto': current.tenant('shop', { hasKey: true }) },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(current.decrypts).toEqual([]);

    const old = new FakeCryptoServer();
    await bootShop(
      new FakeRedis(),
      {},
      {
        bindings: { 'agora.crypto': old.tenant('shop', { hasKey: 'old' }) },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(old.decrypts).toEqual(['shop/console-telescope']);

    const refusing = new FakeCryptoServer();
    const shop = await bootShop(
      new FakeRedis(),
      {},
      {
        bindings: { 'agora.crypto': refusing.tenant('shop', { hasKey: 'forbidden' }) },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refusing.decrypts).toEqual([]);
    expect(shop.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      expect.stringContaining(
        'the crypto server refused this app on the crypto key "console-telescope"',
      ),
    ]);
  });
});

describe('§13e: crypto apps do not publish their token key', () => {
  it('with crypto active nothing is published and nothing is said', async () => {
    const crypto = new FakeCryptoServer();
    const published: string[] = [];
    const authkit = {
      ...fakeAuthkit('shop', { hub: ['*'] }).client,
      publishAppKey: async ({ purpose }: { purpose: string }) => {
        published.push(purpose);
      },
    };
    const shop = await bootShop(
      new FakeRedis(),
      {},
      {
        bindings: { 'agora.crypto': crypto.tenant('shop'), 'authkit.client': authkit },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toEqual([]);
    expect(shop.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('explicit crypto that requires a token (verifyTenant, migrating) still publishes it', async () => {
    const crypto = new FakeCryptoServer();
    const published: string[] = [];
    const authkit = {
      ...fakeAuthkit('shop', { hub: ['*'] }).client,
      publishAppKey: async ({ purpose }: { purpose: string }) => {
        published.push(purpose);
      },
    };
    const shop = await bootShop(
      new FakeRedis(),
      {
        crypto: { cipher: crypto.tenant('shop').operations },
        verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-ingest-secret' } }),
      },
      { bindings: { 'authkit.client': authkit } },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toEqual(['console:telescope']);
    expect(shop.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('token mode as the only way in, with no way to publish: one warning', async () => {
    const { publishAppKey: _none, ...client } = {
      ...fakeAuthkit('shop', { hub: ['*'] }).client,
      publishAppKey: undefined,
    };
    const shop = await bootShop(new FakeRedis(), {}, { bindings: { 'authkit.client': client } });
    expect(shop.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      "[@adonis-agora/telescope] console commands: token mode is this app's only way to be reached, but authkit-client's `service` is not configured, so its key is not in authkit's key directory: configure it, or give each console apps.federated.<app>.commands.publicKey (`node ace telescope:console:key` prints it)",
    ]);
  });
});

describe('§13a: an auto-chosen token that cannot be minted falls back to crypto', () => {
  it('a stale directory key and no grant: the command goes by crypto, with the §13b warning', async () => {
    const crypto = new FakeCryptoServer();
    const redis = new FakeRedis();
    await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    // A key an older version of the app published; the Hub has no grant to mint a token for it.
    const published = new Map<string, unknown>([
      ['shop/console:telescope', { kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43) }],
    ]);
    const minted: string[] = [];
    const authkit = {
      ...fakeAuthkit('hub', {}).client,
      appCallTokens: () => ({
        token: async (app: string) => {
          minted.push(app);
          throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
        },
        reset: () => {},
      }),
      appKey: async ({ app, purpose }: { app: string; purpose: string }) =>
        (published.get(`${app}/${purpose}`) as never) ?? null,
    };
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': authkit },
      },
    );
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    // A missing grant is only `info` (§13b): crypto works without the token.
    expect(hub.logs.filter((l) => l.message.includes('sending without'))).toEqual([
      {
        level: 'info',
        message:
          '[@adonis-agora/telescope] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client telescope:console:* on "shop" in authkit.',
      },
    ]);
    expect(crypto.audit).toContain(
      'encrypt shop/console-telescope [crypto:encrypt:console-telescope]',
    );
    // The first command tried the token (then crypto's optional one); the next ones, inside the
    // 5-minute window, go by crypto with no failing mint.
    expect(minted).toEqual(['shop', 'shop']);
  });

  it('a command the app does not answer after the fallback keeps crypto (no mint per command)', async () => {
    const crypto = new FakeCryptoServer();
    const published = new Map<string, unknown>([
      ['shop/console:telescope', { kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43) }],
    ]);
    const minted: string[] = [];
    const lookups: string[] = [];
    const authkit = {
      ...fakeAuthkit('hub', {}).client,
      appCallTokens: () => ({
        token: async (app: string) => {
          minted.push(app);
          throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
        },
        reset: () => {},
      }),
      appKey: async ({ app, purpose }: { app: string; purpose: string }) => {
        lookups.push(app);
        return (published.get(`${app}/${purpose}`) as never) ?? null;
      },
    };
    // Nothing answers on this Redis: every command times out.
    const hub = await bootHub(
      new FakeRedis(),
      {},
      { bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': authkit } },
    );
    expect((await hub.shop.run('health', [])).status).toBe(503);
    expect((await hub.shop.run('health', [])).status).toBe(503);
    expect(lookups).toEqual(['shop']);
    expect(minted).toEqual(['shop', 'shop']);
  });
});

describe('§13b: the level of the "without a token" line', () => {
  it('is warn when the token failed for another reason than a missing grant', async () => {
    const crypto = new FakeCryptoServer();
    const redis = new FakeRedis();
    await bootShop(redis, {}, { bindings: { 'agora.crypto': crypto.tenant('shop') } });
    const authkit = {
      ...fakeAuthkit('hub', {}).client,
      appCallTokens: () => ({
        token: async () => {
          throw new Error('authkit unreachable (ECONNREFUSED)');
        },
        reset: () => {},
      }),
    };
    const hub = await bootHub(
      redis,
      {},
      {
        bindings: { 'agora.crypto': crypto.embedded('hub'), 'authkit.client': authkit },
      },
    );
    expect((await hub.shop.run('health', [])).status).toBeLessThan(500);
    expect(hub.logs.filter((l) => l.message.includes('sending without'))).toEqual([
      {
        level: 'warn',
        message:
          '[@adonis-agora/telescope] console commands to "shop": sending without an authkit app-call token (crypto only): authkit unreachable (ECONNREFUSED). To attach it: grant the console\'s service client telescope:console:* on "shop" in authkit.',
      },
    ]);
  });
});

describe('§13b: what counts as a missing grant', () => {
  it('the code or message invalid_target, or "not granted" / "no grant"; nothing else', async () => {
    const { isMissingGrant } = await import('../../src/federation/auto_crypto.js');
    expect(isMissingGrant(Object.assign(new Error('x'), { code: 'invalid_target' }))).toBe(true);
    expect(isMissingGrant(new Error('the app is NOT GRANTED to this client'))).toBe(true);
    expect(isMissingGrant(new Error('No grant for shop'))).toBe(true);
    expect(isMissingGrant(Object.assign(new Error('x'), { code: 'unauthorized_client' }))).toBe(
      false,
    );
    expect(isMissingGrant(Object.assign(new Error('x'), { code: 'invalid_client' }))).toBe(false);
    // A message naming invalid_target, with no code, is a missing grant too.
    expect(
      isMissingGrant(new Error('authkit answered 400: invalid_target (urn:agora:app:shop)')),
    ).toBe(true);
    expect(isMissingGrant(new Error('authkit answered 401: unauthorized_client'))).toBe(false);
  });
});
