import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TelescopeUiProvider from '../../providers/telescope_ui_provider.js';
import { scopedTelescopeTools } from '../../src/dev_tools/telescope_tools.js';
import {
  checks,
  FleetRegistry,
  HealthChecks,
  InMemoryTelescopeStore,
  type InstanceHeartbeat,
  MemoryFleetStore,
  resolveConfig,
} from '../../src/index.js';
import {
  resetTelescopeRuntime,
  setTelescopeFleet,
  setTelescopeRuntime,
} from '../../src/registry.js';
import { makeRequest, RecordingResponse } from '../../src/ui/http.js';

type Handler = (ctx: unknown) => unknown;
interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

function heartbeat(instanceId: string, host: string, overrides: Partial<InstanceHeartbeat> = {}) {
  return {
    v: 1,
    instanceId,
    host,
    pid: 1,
    version: 'v1',
    bootedAt: new Date(Date.now() - 60_000).toISOString(),
    sentAt: new Date().toISOString(),
    state: 'ready',
    intervalMs: 15_000,
    checks: [],
    shipping: null,
    ...overrides,
  } satisfies InstanceHeartbeat;
}

async function seededFleet() {
  const fleet = new FleetRegistry(new MemoryFleetStore());
  await fleet.beat('a', heartbeat('a-1', 'host-a'));
  await fleet.beat(
    'b',
    heartbeat('b-1', 'host-b-secret', {
      checks: [
        {
          name: 'redis-b-secret',
          status: 'down',
          message: 'b down',
          since: Date.now() - 1000,
          checkedAt: Date.now(),
          durationMs: 1,
          critical: true,
        },
      ],
    }),
  );
  return fleet;
}

async function bootConsole(authorize: unknown, topology: Record<string, unknown> = {}) {
  const routes: Route[] = [];
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  const app = {
    inProduction: false,
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'telescope_ui' ? { authorize } : key === 'telescope' ? topology : fallback,
    },
    container: {
      hasBinding: () => false,
      make: async (binding: string) => {
        if (binding === 'logger') return { warn: () => {}, debug: () => {}, info: () => {} };
        if (binding === 'router') return { get: add('GET'), post: add('POST') };
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  };
  await new TelescopeUiProvider(app as unknown as ApplicationService).boot();
  return routes;
}

async function call(route: Route, qs: Record<string, unknown>, headers: Record<string, string>) {
  const response = new RecordingResponse();
  const request = makeRequest('GET', qs, headers);
  await route.handler({ request, response, params: {} });
  return { status: response.statusCode, body: response.body as { data?: Record<string, unknown> } };
}

describe('fleet scope', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    resetTelescopeRuntime();
    vi.restoreAllMocks();
  });

  /** `x-apps: *` sees every app; `x-apps: a` only a; `x-tenants: t1` is limited to an organization. */
  const authorize = (ctx: { request: { header(name: string): string | undefined } }) => {
    const apps = ctx.request.header('x-apps');
    const tenants = ctx.request.header('x-tenants');
    return {
      allowed: true,
      apps: apps === '*' || apps === undefined ? '*' : [apps],
      ...(tenants !== undefined ? { tenants: [tenants] } : {}),
    };
  };

  it('a viewer limited to app a never sees app b, with or without ?app=', async () => {
    setTelescopeRuntime(new InMemoryTelescopeStore(), true);
    setTelescopeFleet({ fleet: await seededFleet(), healthChecks: null, reporter: null });
    const routes = await bootConsole(authorize, { topology: 'standalone' });
    const fleet = routes.find((r) => r.pattern.endsWith('/api/fleet')) as Route;

    for (const qs of [{}, { app: 'b' }, { app: '*' }]) {
      const { status, body } = await call(fleet, qs, { 'x-apps': 'a' });
      expect(status).toBe(200);
      const text = JSON.stringify(body);
      expect(text).not.toContain('host-b');
      expect(text).not.toContain('redis-b-secret');
      expect(text).not.toContain('"b"');
    }
    const own = await call(fleet, {}, { 'x-apps': 'a' });
    expect(((own.body.data?.apps ?? []) as Array<{ app: string }>).map((a) => a.app)).toEqual([
      'a',
    ]);

    // Everyone: both apps; `?app=` narrows to one.
    const all = await call(fleet, {}, { 'x-apps': '*' });
    expect(((all.body.data?.apps ?? []) as Array<{ app: string }>).map((a) => a.app)).toEqual([
      'a',
      'b',
    ]);
    const onlyB = await call(fleet, { app: 'b' }, { 'x-apps': '*' });
    expect(((onlyB.body.data?.apps ?? []) as Array<{ app: string }>).map((a) => a.app)).toEqual([
      'b',
    ]);
  });

  it('a viewer limited to an organization sees no instance (they are shared)', async () => {
    const SLOT = Symbol.for('@agora/context:tenancy');
    (globalThis as Record<symbol, unknown>)[SLOT] = {
      version: 1,
      tenancy: () => ({ enabled: true }),
      tenantFilter: () => ({ mode: 'system' }),
      tenantLabels: async () => ({}),
    };
    try {
      setTelescopeRuntime(new InMemoryTelescopeStore(), true);
      setTelescopeFleet({
        fleet: await seededFleet(),
        healthChecks: new HealthChecks([checks.custom('redis', () => ({ status: 'ok' }))]),
        reporter: null,
      });
      const tenantAuthorize = (ctx: { request: { header(name: string): string | undefined } }) => {
        const tenants = ctx.request.header('x-tenants');
        return { allowed: true, tenants: tenants === '*' ? '*' : [tenants] };
      };
      const routes = await bootConsole(tenantAuthorize);
      const fleet = routes.find((r) => r.pattern.endsWith('/api/fleet')) as Route;
      const health = routes.find((r) => r.pattern.endsWith('/api/health')) as Route;

      const limited = await call(fleet, {}, { 'x-tenants': 'acme' });
      expect(limited.body.data).toMatchObject({ apps: [], self: null });
      expect(String(limited.body.data?.notice)).toMatch(/every organization/);
      expect(JSON.stringify(limited.body)).not.toContain('host-');
      expect((await call(health, {}, { 'x-tenants': 'acme' })).status).toBe(403);

      const everyone = await call(fleet, {}, { 'x-tenants': '*' });
      expect(((everyone.body.data?.apps ?? []) as unknown[]).length).toBe(2);
      expect((await call(health, {}, { 'x-tenants': '*' })).body.data).toMatchObject({
        configured: true,
        status: 'ok',
        checks: [{ name: 'redis', status: 'ok' }],
      });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SLOT];
    }
  });

  it('readFleet hides the fleet from an organization-limited scope', async () => {
    const { readFleet } = await import('../../src/index.js');
    const view = await readFleet({ apps: null, hidden: true }, { fleet: await seededFleet() });
    expect(view.apps).toEqual([]);
    expect(view.notice).toMatch(/every organization/);
  });

  it('a standalone without a fleet says so', async () => {
    setTelescopeRuntime(new InMemoryTelescopeStore(), true);
    const routes = await bootConsole(authorize);
    const fleet = routes.find((r) => r.pattern.endsWith('/api/fleet')) as Route;
    const { body } = await call(fleet, {}, { 'x-apps': '*' });
    expect(body.data).toMatchObject({ enabled: false, apps: [] });
  });

  it('the MCP tool reads the apps the caller was granted', async () => {
    setTelescopeFleet({ fleet: await seededFleet(), healthChecks: null, reporter: null });
    const toolsFor = scopedTelescopeTools(new InMemoryTelescopeStore(), resolveConfig({}));
    const limited = (await toolsFor({ apps: ['a'] }).call('get_fleet', {})) as {
      apps: Array<{ app: string }>;
    };
    expect(limited.apps.map((a) => a.app)).toEqual(['a']);
    expect(JSON.stringify(limited)).not.toContain('host-b');
    const everyone = (await toolsFor({}).call('get_fleet', {})) as { apps: Array<{ app: string }> };
    expect(everyone.apps.map((a) => a.app)).toEqual(['a', 'b']);
  });
});
