import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeMcpProvider from '../providers/telescope_mcp_provider.js';
import { MISSING_MCP_AUTHORIZE_WARNING } from '../src/mcp/define_config.js';

/** Just enough of the app for `boot()` to reach (and stop after) its access checks. */
function fakeApp(inProduction: boolean, mcpConfig: unknown) {
  const warn = vi.fn();
  const app = {
    inProduction,
    config: { get: (key: string) => (key === 'telescope_mcp' ? mcpConfig : undefined) },
    container: {
      make: async (binding: string) => {
        if (binding === 'logger') return { warn };
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  };
  return { app: app as unknown as ApplicationService, warn };
}

describe('telescope_mcp provider: authorize omitted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the warning exactly once at boot, naming config/telescope_mcp.ts', async () => {
    // No telescope runtime is booted here, so boot() stops right after the access checks.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, warn } = fakeApp(true, {});
    await new TelescopeMcpProvider(app).boot();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MISSING_MCP_AUTHORIZE_WARNING);
    expect(MISSING_MCP_AUTHORIZE_WARNING).toBe(
      '[@adonis-agora/telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/telescope_mcp.ts.',
    );
  });

  it('logs the same warning outside production too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dev = fakeApp(false, {});
    await new TelescopeMcpProvider(dev.app).boot();
    expect(dev.warn).toHaveBeenCalledTimes(1);
    expect(dev.warn).toHaveBeenCalledWith(MISSING_MCP_AUTHORIZE_WARNING);
  });

  it('stays quiet when authorize is set or the endpoint is off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const configured = fakeApp(true, { authorize: () => true });
    await new TelescopeMcpProvider(configured.app).boot();
    expect(configured.warn).not.toHaveBeenCalled();

    const disabled = fakeApp(true, { enabled: false });
    await new TelescopeMcpProvider(disabled.app).boot();
    expect(disabled.warn).not.toHaveBeenCalled();
  });
});
