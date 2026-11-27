import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeProvider from '../../providers/telescope_provider.js';
import { defineConfig } from '../../src/define_config.js';
import { telescopeDoctorChecks } from '../../src/doctor/checks.js';
import { resetTelescopeRuntime } from '../../src/registry.js';
import {
  authkitTenantClient,
  fillTenantFromAuthkit,
  MissingTenantError,
  tenantProvenance,
} from '../../src/topology/auto_tenant.js';
import { resolveTopology } from '../../src/topology/config.js';
import { activeRemoteStores } from '../../src/topology/remote_store.js';
import { resetToken, TELESCOPE_RESOURCE } from '../../src/topology/verify.js';

/** A fake `authkit.client` binding: `tenantOf` as authkit-client's contract describes it. */
function fakeAuthkit(partition = 'shop') {
  const calls: string[] = [];
  const url = Object.assign(async () => 'http://central:3334', {
    refresh: async () => 'http://central-2:3334',
  });
  const reset = vi.fn();
  const token = Object.assign(async () => 'auto-token', { reset });
  return {
    calls,
    reset,
    client: {
      tenantOf(resource: string) {
        calls.push(resource);
        return { url, token, partition };
      },
    },
  };
}

function fakeApp(
  config: Record<string, unknown>,
  bindings: Record<string, unknown> = {},
  environment?: string,
) {
  const warnings: string[] = [];
  const app = {
    inProduction: false,
    ...(environment ? { getEnvironment: () => environment } : {}),
    config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
    container: {
      hasBinding: (key: string) => key in bindings,
      bindValue: () => {},
      singleton: () => {},
      make: async (key: string) => {
        if (key === 'logger') {
          return { warn: (m: string) => warnings.push(m), debug: () => {}, info: () => {} };
        }
        if (key === 'router') return { post: () => ({}), get: () => ({}) };
        return bindings[key];
      },
    },
  };
  return { app: app as unknown as ApplicationService, warnings };
}

const quiet = { overload: { enabled: false }, watchers: [] as never[] };
const providers: TelescopeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.shutdown();
  for (const store of [...activeRemoteStores]) store.stop();
  resetTelescopeRuntime();
});

async function boot(
  config: Record<string, unknown>,
  bindings: Record<string, unknown> = {},
  environment?: string,
) {
  const fake = fakeApp({ telescope: config }, bindings, environment);
  const provider = new TelescopeProvider(fake.app);
  providers.push(provider);
  provider.register();
  await provider.boot();
  return fake;
}

describe('tenant from authkit-client', () => {
  it('defineConfig accepts the one-line tenant (the fields are checked at boot)', () => {
    expect(() => defineConfig({ topology: 'tenant' })).not.toThrow();
    expect(() => resolveTopology({ topology: 'tenant' })).toThrow(MissingTenantError);
    // What is set is still validated when the file loads.
    expect(() => defineConfig({ topology: 'tenant', tenant: { partition: 'not ok' } })).toThrow(
      /partition must be 1-64/,
    );
    expect(() => defineConfig({ topology: 'tenant', tenant: { url: 'ftp://x' } })).toThrow(
      /absolute http/,
    );
  });

  it('an async tenantOf works too', async () => {
    const authkit = fakeAuthkit('billing');
    const client = { tenantOf: async (resource: string) => authkit.client.tenantOf(resource) };
    const config = { topology: 'tenant' as const };
    await fillTenantFromAuthkit(fakeApp({}, { 'authkit.client': client }).app.container, config);
    const topology = resolveTopology(config);
    expect(topology.topology === 'tenant' && topology.tenant.partition).toBe('billing');
  });

  it('fills url, token and partition from tenantOf(urn:agora:telescope)', async () => {
    const authkit = fakeAuthkit();
    const config = { ...quiet, topology: 'tenant' as const };
    await boot(config, { 'authkit.client': authkit.client });
    expect(authkit.calls).toEqual([TELESCOPE_RESOURCE]);
    expect(TELESCOPE_RESOURCE).toBe('urn:agora:telescope');
    expect(activeRemoteStores.size).toBe(1);
    const topology = resolveTopology(config);
    if (topology.topology !== 'tenant') throw new Error('not a tenant');
    expect(topology.tenant.partition).toBe('shop');
    expect(typeof topology.tenant.url).toBe('function');
    // The auto token keeps its reset(), so a 401 drops it.
    resetToken(topology.tenant.token);
    expect(authkit.reset).toHaveBeenCalledOnce();
    expect(tenantProvenance(config)).toEqual({
      url: 'authkit-client (auto)',
      token: 'authkit-client (auto)',
      partition: 'authkit-client (auto)',
    });
    const check = telescopeDoctorChecks.find((c) => c.id === 'telescope.tenant-source');
    expect(
      await check?.run(fakeApp({ telescope: config }, { 'authkit.client': authkit.client }).app),
    ).toEqual({
      status: 'ok',
      message:
        'tenant url: authkit-client (auto), token: authkit-client (auto), partition: authkit-client (auto).',
    });
  });

  it('anything explicit wins, field by field', async () => {
    const authkit = fakeAuthkit();
    const config = { topology: 'tenant' as const, tenant: { partition: 'billing', token: 'mine' } };
    await fillTenantFromAuthkit(
      fakeApp({}, { 'authkit.client': authkit.client }).app.container,
      config,
    );
    const topology = resolveTopology(config);
    if (topology.topology !== 'tenant') throw new Error('not a tenant');
    expect(topology.tenant.partition).toBe('billing');
    expect(topology.tenant.token).toBe('mine');
    expect(typeof topology.tenant.url).toBe('function');
    expect(tenantProvenance(config)).toEqual({
      url: 'authkit-client (auto)',
      token: 'explicit',
      partition: 'explicit',
    });
    const check = telescopeDoctorChecks.find((c) => c.id === 'telescope.tenant-source');
    expect(await check?.run(fakeApp({ telescope: config }).app)).toMatchObject({
      message: 'tenant url: authkit-client (auto), token: explicit, partition: explicit.',
    });
  });

  it('everything explicit: tenantOf is never called', async () => {
    const authkit = fakeAuthkit();
    const config = {
      topology: 'tenant' as const,
      tenant: { url: 'http://x', partition: 'a', token: 't' },
    };
    await fillTenantFromAuthkit(
      fakeApp({}, { 'authkit.client': authkit.client }).app.container,
      config,
    );
    expect(authkit.calls).toEqual([]);
    expect(tenantProvenance(config)).toEqual({
      url: 'explicit',
      token: 'explicit',
      partition: 'explicit',
    });
  });

  it('no binding: the web process refuses to boot and names both fixes', async () => {
    await expect(boot({ ...quiet, topology: 'tenant' }, {}, 'web')).rejects.toThrow(
      "[@adonis-agora/telescope] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. Configure @adonis-agora/authkit-client's `service` (config/authkit_client.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/telescope.ts.",
    );
  });

  it('no binding in an ace command: telescope is off there, with a warning', async () => {
    const { warnings } = await boot(
      { ...quiet, topology: 'tenant', tenant: { partition: 'a' } },
      {},
      'console',
    );
    expect(activeRemoteStores.size).toBe(0);
    expect(warnings.join('\n')).toContain('needs tenant.url, tenant.token');
  });

  it('no binding in an ace command: a worker (staysAlive) fails when it starts', async () => {
    const hooks: Array<(command: unknown, isMain: boolean) => Promise<void> | void> = [];
    const ace = { executing: (hook: (typeof hooks)[number]) => hooks.push(hook) };
    await boot({ ...quiet, topology: 'tenant' }, { ace }, 'console');
    expect(hooks).toHaveLength(1);
    const hook = hooks[0];
    await expect(Promise.resolve(hook?.({}, true))).resolves.toBeUndefined();
    await expect(Promise.resolve(hook?.({ staysAlive: true }, false))).resolves.toBeUndefined();
    class Worker {
      static options = { staysAlive: true };
    }
    await expect(Promise.resolve(hook?.(new Worker(), true))).rejects.toThrow(MissingTenantError);
  });

  it('a binding without tenantOf (older authkit-client) is treated as absent', async () => {
    const old = { appCallTokens: () => undefined };
    expect(await authkitTenantClient(fakeApp({}, { 'authkit.client': old }).app.container)).toBe(
      undefined,
    );
    await expect(
      boot({ ...quiet, topology: 'tenant' }, { 'authkit.client': old }, 'web'),
    ).rejects.toThrow(/needs tenant\.url, tenant\.token, tenant\.partition/);
  });

  it('tenantOf throwing (no `service`) puts its message in the boot error', async () => {
    const client = {
      tenantOf() {
        throw new Error('service is not configured: add service: { name, clientId, clientSecret }');
      },
    };
    await expect(
      boot({ ...quiet, topology: 'tenant' }, { 'authkit.client': client }, 'web'),
    ).rejects.toThrow(/\(authkit-client: service is not configured/);
  });

  it('tenant.auto: false ignores the binding', async () => {
    const authkit = fakeAuthkit();
    await expect(
      boot(
        { ...quiet, topology: 'tenant', tenant: { auto: false, token: 't' } },
        { 'authkit.client': authkit.client },
        'web',
      ),
    ).rejects.toThrow(/needs tenant\.url, tenant\.partition\./);
    expect(authkit.calls).toEqual([]);
  });
});
