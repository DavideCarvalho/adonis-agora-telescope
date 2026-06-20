import type { ApplicationService } from '@adonisjs/core/types';
import { Alerter } from '../src/alerts/alerter.js';
import { type TelescopeAlertsConfig, resolveConfig } from '../src/alerts/define_config.js';
import { ExceptionPoller } from '../src/alerts/exception_source.js';
import { getTelescopeRuntime } from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';

/**
 * Wires `@agora/telescope/alerts` into the AdonisJS application.
 *
 * - `boot()` reads `config/telescope_alerts.ts` (falling back to an
 *   `alerts_config` key on `config/telescope.ts`), resolves the live telescope
 *   store from the core's runtime slot (no DI — same handle the watchers record
 *   through), and starts an {@link ExceptionPoller} that feeds new exception
 *   entries to an {@link Alerter}.
 * - `shutdown()` stops the poller.
 *
 * Alerting never throws into the app: a disabled config, a missing store, or a
 * failing channel all degrade to doing nothing (failures are warn-logged).
 */
export default class TelescopeAlertsProvider {
  private poller: ExceptionPoller | null = null;

  constructor(protected app: ApplicationService) {}

  private resolve() {
    const own = this.app.config.get<TelescopeAlertsConfig | undefined>(
      'telescope_alerts',
      undefined,
    );
    if (own !== undefined) return resolveConfig(own);

    const fromTelescope = this.app.config.get<TelescopeAlertsConfig | undefined>(
      'telescope.alerts_config',
      undefined,
    );
    return resolveConfig(fromTelescope);
  }

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;

    let store: TelescopeStore | null;
    try {
      store = getTelescopeRuntime().store;
    } catch (err) {
      console.error(
        `TelescopeAlertsProvider: could not resolve the telescope store: ${asMessage(err)}`,
      );
      return;
    }
    if (store === null) return;

    const alerter = new Alerter({ alerts: config });
    this.poller = new ExceptionPoller({
      store,
      alerter,
      intervalMs: config.intervalMs,
    });
    try {
      this.poller.start();
    } catch (err) {
      console.error(`TelescopeAlertsProvider: failed to start the alert poller: ${asMessage(err)}`);
      this.poller = null;
    }
  }

  async shutdown() {
    try {
      this.poller?.stop();
    } catch {
      // never throw out of shutdown
    }
    this.poller = null;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
