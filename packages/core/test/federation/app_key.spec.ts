import { defineConfig, drivers } from '@adonisjs/core/encryption';
import { Secret } from '@adonisjs/core/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appKeyOf } from '../../src/federation/console_commands.js';

/**
 * APP_KEY resolution (SECURITY-UNIFORM-SPEC §13c, the same in every Agora lib): `config/app.ts`'s
 * `appKey` → the default entry of `config/encryption.ts` (AdonisJS 7, lazy providers resolved) →
 * `process.env.APP_KEY`.
 */

const KEY = 'app-key-from-config-0123456789';
const ENCRYPTION_KEY = 'app-key-from-encryption-012345';
const ENV_KEY = 'app-key-from-the-environment-0';

const appWith = (config: Record<string, unknown>) => ({
  config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
});

const savedEnv = process.env.APP_KEY;
beforeEach(() => {
  delete process.env.APP_KEY;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = savedEnv;
});

describe('appKeyOf (§13c)', () => {
  it('reads config/app.ts appKey, as a string or a Secret', async () => {
    expect(await appKeyOf(appWith({ 'app.appKey': KEY }))).toBe(KEY);
    expect(await appKeyOf(appWith({ 'app.appKey': new Secret(KEY) }))).toBe(KEY);
  });

  it('reads the default entry of config/encryption.ts (AdonisJS 7 defineConfig + drivers)', async () => {
    // EduLiberta's file: the key only lives here.
    const legacy = defineConfig({
      default: 'legacy',
      list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
    });
    expect(await appKeyOf(appWith({ encryption: legacy }))).toBe(ENCRYPTION_KEY);
    const several = defineConfig({
      default: 'app',
      list: {
        backup: drivers.aes256gcm({ id: 'backup', keys: ['backup-key-0123456789abcdef'] }),
        app: drivers.aes256gcm({ id: 'app', keys: [ENCRYPTION_KEY, 'old-key-0123456789abcdef'] }),
      },
    });
    expect(await appKeyOf(appWith({ encryption: several }))).toBe(ENCRYPTION_KEY);
    const noDefault = defineConfig({
      list: { only: drivers.aes256gcm({ id: 'only', keys: [ENCRYPTION_KEY] }) },
    } as never);
    expect(await appKeyOf(appWith({ encryption: noDefault }))).toBe(ENCRYPTION_KEY);
  });

  it('reads already-resolved and flat encryption configs (keys[0] or key)', async () => {
    const list = { default: 'a', list: { a: { keys: [ENCRYPTION_KEY] } } };
    expect(await appKeyOf(appWith({ encryption: list }))).toBe(ENCRYPTION_KEY);
    const single = { default: 'a', list: { a: { key: new Secret(ENCRYPTION_KEY) } } };
    expect(await appKeyOf(appWith({ encryption: single }))).toBe(ENCRYPTION_KEY);
    expect(await appKeyOf(appWith({ encryption: { keys: [ENCRYPTION_KEY] } }))).toBe(
      ENCRYPTION_KEY,
    );
  });

  it('falls back to process.env.APP_KEY, in that order', async () => {
    process.env.APP_KEY = ENV_KEY;
    const encryption = defineConfig({
      default: 'a',
      list: { a: drivers.aes256gcm({ id: 'a', keys: [ENCRYPTION_KEY] }) },
    });
    expect(await appKeyOf(appWith({ 'app.appKey': KEY, encryption }))).toBe(KEY);
    expect(await appKeyOf(appWith({ encryption }))).toBe(ENCRYPTION_KEY);
    expect(await appKeyOf(appWith({}))).toBe(ENV_KEY);
    const empty = defineConfig({
      list: { a: drivers.aes256gcm({ id: 'a', keys: [''] }) },
    } as never);
    expect(await appKeyOf(appWith({ encryption: empty }))).toBe(ENV_KEY);
  });

  it('is undefined with no source, and survives a throwing config', async () => {
    expect(await appKeyOf(appWith({}))).toBeUndefined();
    const broken = {
      config: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await appKeyOf(broken)).toBeUndefined();
    const failing = { type: 'provider', resolver: async () => Promise.reject(new Error('x')) };
    expect(await appKeyOf(appWith({ encryption: failing }))).toBeUndefined();
  });
});
