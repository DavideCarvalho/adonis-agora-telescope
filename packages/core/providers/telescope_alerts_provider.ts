import type { ApplicationService } from '@adonisjs/core/types';
import type { ExceptionEntryContent } from '../src/ai/diagnoser.js';
import { Alerter } from '../src/alerts/alerter.js';
import { AlerterService } from '../src/alerts/alerter_service.js';
import { type TelescopeAlertsConfig, resolveConfig } from '../src/alerts/define_config.js';
import { ExceptionPoller } from '../src/alerts/exception_source.js';
import type { Entry } from '../src/entry.js';
import { MetricsService } from '../src/metrics/metrics_service.js';
import { getTelescopeRuntime } from '../src/registry.js';
import type { TelescopeStore } from '../src/store.js';

/**
 * Wires `@adonis-agora/telescope/alerts` into the AdonisJS application.
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
  private alerterService: AlerterService | null = null;

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

    // Attach the AI probable-cause hook when a configured coordinator is published
    // in the runtime slot. When AI is off, no hook is passed and alerts are
    // exactly as before (no "Probable cause (AI)" section).
    const coordinator = getTelescopeRuntime().diagnosisCoordinator;
    const diagnose =
      coordinator !== null && coordinator.isConfigured()
        ? (entry: Entry) => coordinator.diagnoseSummary(entry as Entry<ExceptionEntryContent>)
        : undefined;

    const alerter = new Alerter({
      alerts: config,
      ...(diagnose !== undefined ? { diagnose } : {}),
    });
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

    // The interval metric-threshold service only needs to run when at least one
    // such rule is configured — otherwise its timer would tick doing nothing.
    const hasMetricRule = config.rules.some((rule) => rule.type === 'metric-threshold');
    if (hasMetricRule) {
      this.alerterService = new AlerterService({
        alerts: config,
        metrics: new MetricsService(store),
      });
      try {
        this.alerterService.start();
      } catch (err) {
        console.error(
          `TelescopeAlertsProvider: failed to start the metric alerter: ${asMessage(err)}`,
        );
        this.alerterService = null;
      }
    }
  }

  async shutdown() {
    try {
      this.poller?.stop();
    } catch {
      // never throw out of shutdown
    }
    try {
      this.alerterService?.stop();
    } catch {
      // never throw out of shutdown
    }
    this.poller = null;
    this.alerterService = null;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
