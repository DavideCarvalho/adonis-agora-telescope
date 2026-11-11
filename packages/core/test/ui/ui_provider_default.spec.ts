import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TelescopeUiProvider from '../../providers/telescope_ui_provider.js';
import { MISSING_AUTHORIZE_WARNING } from '../../src/ui/define_config.js';

/** Just enough of the app for `boot()` to reach (and stop after) its access checks. */
function fakeApp(inProduction: boolean, uiConfig: unknown) {
  const warn = vi.fn();
  const app = {
    inProduction,
    config: { get: (key: string) => (key === 'telescope_ui' ? uiConfig : undefined) },
    container: {
      make: async (binding: string) => {
        if (binding === 'logger') return { warn };
        throw new Error(`unexpected binding ${binding}`);
      },
    },
  };
  return { app: app as unknown as ApplicationService, warn };
}

describe('telescope_ui provider: authorize omitted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the warning exactly once at boot in production', async () => {
    // No telescope runtime is booted here, so boot() stops right after the access checks.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, warn } = fakeApp(true, {});
    await new TelescopeUiProvider(app).boot();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MISSING_AUTHORIZE_WARNING);
    expect(MISSING_AUTHORIZE_WARNING).toBe(
      '[@adonis-agora/telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/telescope_ui.ts.',
    );
  });

  it('stays quiet outside production and when authorize is set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dev = fakeApp(false, {});
    await new TelescopeUiProvider(dev.app).boot();
    expect(dev.warn).not.toHaveBeenCalled();

    const configured = fakeApp(true, { authorize: () => true });
    await new TelescopeUiProvider(configured.app).boot();
    expect(configured.warn).not.toHaveBeenCalled();

    const disabled = fakeApp(true, { enabled: false });
    await new TelescopeUiProvider(disabled.app).boot();
    expect(disabled.warn).not.toHaveBeenCalled();
  });
});
