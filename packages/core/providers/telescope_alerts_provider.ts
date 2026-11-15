import type { ApplicationService } from '@adonisjs/core/types';
import type { ExceptionEntryContent } from '../src/ai/diagnoser.js';
import { Alerter } from '../src/alerts/alerter.js';
import { AlerterService, isFleetRule } from '../src/alerts/alerter_service.js';
import { resolveConfig, type TelescopeAlertsConfig } from '../src/alerts/define_config.js';
import { ExceptionPoller } from '../src/alerts/exception_source.js';
import { type CheckStateSource, publishedCheckStates } from '../src/alerts/integrations/health.js';
import { HeartbeatMonitor } from '../src/alerts/integrations/heartbeats.js';
import { StatusPageSync } from '../src/alerts/integrations/status_pages.js';
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
  private heartbeats: HeartbeatMonitor | null = null;
  private statusPages: StatusPageSync | null = null;

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

    // Uptime integrations need no store: they read check states, not entries.
    this.startUptime(config.heartbeats ?? [], config.statusPages ?? [], config.checkStates ?? null);

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
    const diagnose = coordinator?.isConfigured()
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
    const hasMetricRule = config.rules.some(
      (rule) => rule.type === 'metric-threshold' || isFleetRule(rule),
    );
    if (config.rules.some(isFleetRule) && getTelescopeRuntime().fleet === null) {
      console.warn(
        'TelescopeAlertsProvider: fleet rules (instances-up, restart-loop, check-down, entries-dropped) need the fleet: they run on a control plane or a standalone app with `fleet` on.',
      );
    }
    if (hasMetricRule) {
      this.alerterService = new AlerterService({
        alerts: config,
        metrics: new MetricsService(store),
        // Read per evaluation: the core provider publishes the fleet at boot.
        fleet: () => getTelescopeRuntime().fleet,
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

  /**
   * Start heartbeats and status page sync. The check-state source is the config's
   * `checkStates`, else the one published at runtime (looked up on every read, so
   * a source published after this boot is picked up).
   */
  private startUptime(
    heartbeats: NonNullable<ReturnType<typeof resolveConfig>['heartbeats']>,
    statusPages: NonNullable<ReturnType<typeof resolveConfig>['statusPages']>,
    configured: CheckStateSource | null,
  ): void {
    // With no source anywhere, `live` returns no states: an app-wide heartbeat
    // is then a plain dead man's switch (healthy while the process runs).
    const source: CheckStateSource = configured ?? live;
    try {
      if (heartbeats.length > 0) {
        this.heartbeats = new HeartbeatMonitor({ heartbeats, source });
        this.heartbeats.start();
      }
      if (statusPages.length > 0) {
        this.statusPages = new StatusPageSync({ statusPages, source });
        this.statusPages.start();
      }
    } catch (err) {
      console.error(
        `TelescopeAlertsProvider: failed to start uptime integrations: ${asMessage(err)}`,
      );
    }
  }

  async shutdown() {
    try {
      this.heartbeats?.stop();
      this.statusPages?.stop();
    } catch {
      // never throw out of shutdown
    }
    this.heartbeats = null;
    this.statusPages = null;
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

/** The published source, read now; no states when none is published. */
function live(): ReturnType<CheckStateSource> {
  const published = publishedCheckStates();
  return published === null ? [] : published();
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
