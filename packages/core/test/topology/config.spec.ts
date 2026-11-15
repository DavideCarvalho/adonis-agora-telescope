import { describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/define_config.js';
import {
  resolveBufferOptions,
  resolveIngestLimits,
  serverPrefix,
} from '../../src/topology/config.js';
import {
  canIngest,
  readToken,
  resolveTenantVerifier,
  sharedSecretVerifier,
  type TenantAuthRequest,
} from '../../src/topology/verify.js';

describe('config', () => {
  it('validates each topology at load time', () => {
    expect(defineConfig({})).toEqual({});
    expect(() => defineConfig({ topology: 'control-plane' } as never)).toThrow(
      /needs `verifyTenant`/,
    );
    expect(() => defineConfig({ topology: 'control-plane', verifyTenant: 'x' } as never)).toThrow(
      /must be a function/,
    );
    expect(() =>
      defineConfig({ topology: 'standalone', verifyTenant: () => null } as never),
    ).toThrow(/only applies to topology 'control-plane'/);
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: 'ftp://x', partition: 'a', token: 't' } }),
    ).toThrow(/absolute http/);
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: 'http://', partition: 'a', token: 't' } }),
    ).toThrow(/absolute http/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'http://x', partition: 'a'.repeat(65), token: 't' },
      }),
    ).toThrow(/partition must be 1-64/);
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: 'http://x', partition: '', token: 't' } }),
    ).toThrow(/partition is required/);
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: 'http://x', partition: 'a', token: '' } }),
    ).toThrow(/token is required/);
    expect(() => defineConfig({ topology: 'edge' } as never)).toThrow(/topology must be/);
    expect(() => defineConfig({ ingest: { maxEntries: 5 } })).toThrow(
      /`ingest` only applies to topology 'control-plane'/,
    );
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'http://x', partition: 'a', token: 't', local: '' },
      }),
    ).toThrow(/tenant.local must name a store/);
  });

  it('standalone is the default: a config without topology resolves as before', () => {
    expect(resolveConfig({}).topology).toEqual({ topology: 'standalone' });
    expect(resolveConfig({ store: 'memory' }).topology).toEqual({ topology: 'standalone' });
    const tenant = resolveConfig({
      topology: 'tenant',
      tenant: { url: 'http://x', partition: 'a', token: 't', buffer: { batchSize: 5 } },
    }).topology;
    expect(tenant).toMatchObject({
      topology: 'tenant',
      buffer: { batchSize: 5, maxEntries: 10_000 },
    });
  });

  it('defaults: the server path, limits and buffer', () => {
    expect(serverPrefix('https://t.example.com')).toBe('https://t.example.com/_telescope/v1');
    expect(serverPrefix('https://t.example.com/')).toBe('https://t.example.com/_telescope/v1');
    expect(serverPrefix('https://t.example.com/obs/')).toBe('https://t.example.com/obs');
    expect(resolveIngestLimits({ path: 'custom/' }).path).toBe('/custom');
    expect(resolveIngestLimits()).toMatchObject({ path: '/_telescope/v1', maxEntries: 1000 });
    expect(resolveBufferOptions({ maxEntries: -1 })).toMatchObject({
      maxEntries: 10_000,
      batchSize: 200,
    });
  });
});

describe('verifyTenant forms', () => {
  const ok = { partition: 'shop', capabilities: ['telescope:ingest'] };
  const req: TenantAuthRequest = { token: 't' };

  it('function, class instance, class and lazy import all resolve', async () => {
    class Verifier {
      verify() {
        return ok;
      }
    }
    expect(await resolveTenantVerifier(() => ok)(req)).toEqual(ok);
    expect(await resolveTenantVerifier(new Verifier())(req)).toEqual(ok);
    expect(await resolveTenantVerifier(Verifier)(req)).toEqual(ok);
    expect(await resolveTenantVerifier(async () => ({ default: Verifier }))(req)).toEqual(ok);
    expect(await resolveTenantVerifier(async () => ({ default: () => ok }))(req)).toEqual(ok);
  });

  it('a malformed answer throws instead of passing as a sender', async () => {
    await expect(
      resolveTenantVerifier(() => ({ tenant: 'shop', capabilities: [] }) as never)(req),
    ).rejects.toThrow(/rename it to `partition`/);
    await expect(
      resolveTenantVerifier(() => ({ partition: 'shop' }) as never)(req),
    ).rejects.toThrow();
  });

  it('sharedSecretVerifier: constant-time secret per app, default ingest capability', async () => {
    const verify = sharedSecretVerifier({ partitions: { shop: 'abc', toString: 'x' } as never });
    expect(await verify({ token: 'abc', partition: 'shop' })).toEqual({
      partition: 'shop',
      capabilities: ['telescope:ingest'],
    });
    expect(await verify({ token: 'abd', partition: 'shop' })).toBeNull();
    expect(await verify({ token: 'abc' })).toBeNull();
    expect(await verify({ token: 'abc', partition: 'constructor' })).toBeNull();
    expect(canIngest(['telescope:*'])).toBe(true);
    expect(canIngest(['telescope:read'])).toBe(false);
  });

  it('token sources: a string, a function, an object with get()', async () => {
    expect(await readToken('a')).toBe('a');
    expect(await readToken(async () => 'b')).toBe('b');
    expect(await readToken({ get: async () => 'c' })).toBe('c');
  });
});
