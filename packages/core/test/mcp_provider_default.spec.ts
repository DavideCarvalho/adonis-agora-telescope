import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeMcpProvider from '../providers/telescope_mcp_provider.js';
import { MISSING_MCP_AUTHORIZE_WARNING, resolveConfig } from '../src/mcp/define_config.js';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../src/registry.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

/** A router that records every route the provider mounts. */
function fakeRouter() {
  const routes: { method: string; path: string; name?: string }[] = [];
  const add = (method: string) => (path: string) => {
    const route: { method: string; path: string; name?: string } = { method, path };
    routes.push(route);
    return {
      as(name: string) {
        route.name = name;
        return this;
      },
    };
  };
  return { routes, router: { post: add('POST'), get: add('GET'), delete: add('DELETE') } };
}

/** Just enough of the app for `boot()`: config, logger and router. */
function fakeApp(inProduction: boolean, mcpConfig: unknown) {
  const warn = vi.fn();
  const { routes, router } = fakeRouter();
  const app = {
    inProduction,
    config: {
      get: (key: string, fallback?: unknown) => (key === 'telescope_mcp' ? mcpConfig : fallback),
    },
    container: {
      make: async (binding: string) => {
        if (binding === 'logger') return { warn };
        if (binding === 'router') return router;
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  };
  return { app: app as unknown as ApplicationService, warn, routes };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTelescopeRuntime();
});

describe('telescope_mcp provider: opt-in', () => {
  it('resolves enabled to false unless the config says true', () => {
    expect(resolveConfig().enabled).toBe(false);
    expect(resolveConfig({}).enabled).toBe(false);
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveConfig({ enabled: true }).enabled).toBe(true);
  });

  it('mounts no route and logs nothing by default (no config file, or one without enabled)', async () => {
    setTelescopeRuntime(new InMemoryTelescopeStore(), false);
    for (const config of [undefined, {}, { authorize: () => true }, { enabled: false }]) {
      const { app, warn, routes } = fakeApp(true, config);
      await new TelescopeMcpProvider(app).boot();
      expect(routes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('with enabled: true mounts the same three routes at the configured path', async () => {
    setTelescopeRuntime(new InMemoryTelescopeStore(), false);
    const { app, warn, routes } = fakeApp(true, {
      enabled: true,
      path: '/custom/mcp/',
      authorize: () => true,
    });
    await new TelescopeMcpProvider(app).boot();
    expect(warn).not.toHaveBeenCalled();
    expect(routes).toEqual([
      { method: 'POST', path: '/custom/mcp', name: 'telescope_mcp.rpc' },
      { method: 'GET', path: '/custom/mcp', name: 'telescope_mcp.get' },
      { method: 'DELETE', path: '/custom/mcp', name: 'telescope_mcp.delete' },
    ]);
  });
});

describe('telescope_mcp provider: enabled without authorize', () => {
  it('logs the warning exactly once at boot, naming config/telescope_mcp.ts', async () => {
    // No telescope runtime is booted here, so boot() stops right after the access checks.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, warn } = fakeApp(true, { enabled: true });
    await new TelescopeMcpProvider(app).boot();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MISSING_MCP_AUTHORIZE_WARNING);
    expect(MISSING_MCP_AUTHORIZE_WARNING).toBe(
      '[@adonis-agora/telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/telescope_mcp.ts.',
    );
  });

  it('logs the same warning outside production too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dev = fakeApp(false, { enabled: true });
    await new TelescopeMcpProvider(dev.app).boot();
    expect(dev.warn).toHaveBeenCalledTimes(1);
    expect(dev.warn).toHaveBeenCalledWith(MISSING_MCP_AUTHORIZE_WARNING);
  });

  it('stays quiet when authorize is set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configured = fakeApp(true, { enabled: true, authorize: () => true });
    await new TelescopeMcpProvider(configured.app).boot();
    expect(configured.warn).not.toHaveBeenCalled();
  });
});
