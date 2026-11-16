import type { FleetView } from '../src/fleet/view.js';
import { TelescopeCommand } from './shared.js';

/** `ms` as `3d 4h`, `12m`, `40s`. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * `telescope:fleet:list`: the console's Fleet page. Per app, the instances up / starting /
 * draining / gone, then each instance, deploys, restart loops and failing checks. `--app` narrows.
 * Exit code 1 when this telescope keeps no fleet.
 */
export class TelescopeFleetList extends TelescopeCommand {
  static override commandName = 'telescope:fleet:list';
  static override description =
    'Instances per app (up, starting, draining, gone), deploys, restart loops and failing checks';

  override async run() {
    const { apis, appIds } = await this.console();
    const body = await this.handle((ctx) => apis.fleetApi.fleet(ctx, { apps: appIds }));
    const view = body.data as FleetView;
    if (!view.enabled) this.exitCode = 1;
    if (this.json) return this.printJson(body);
    if (view.notice !== null) {
      this.logger.warning(view.notice);
      return;
    }
    if (view.apps.length === 0) {
      this.logger.info('No instance has sent a heartbeat yet.');
      return;
    }
    this.table(
      view.apps.map((app) => ({
        app: app.app,
        up: app.counts.up,
        starting: app.counts.starting,
        draining: app.counts.draining,
        gone: app.counts.gone,
        versions: app.versions.map((v) => `${v.version ?? '?'}×${v.instances}`).join(' '),
        checks:
          app.checks
            .map((c) => `${c.name}:${c.status} ${shortDuration(view.now - c.since)}`)
            .join(', ') || 'ok',
      })),
      ['app', 'up', 'starting', 'draining', 'gone', 'versions', 'checks'],
    );
    for (const app of view.apps) {
      this.logger.log('');
      this.logger.info(`${app.app}: instances`);
      this.table(
        app.instances.map((i) => ({
          host: i.host,
          role: i.role,
          status: i.status,
          version: i.version ?? '',
          uptime: shortDuration(i.uptimeMs),
          lastSeen: `${shortDuration(view.now - i.lastSeenAt)} ago`,
          health: i.health,
          buffered: i.shipping?.buffered ?? '',
        })),
        ['host', 'role', 'status', 'version', 'uptime', 'lastSeen', 'health', 'buffered'],
      );
      for (const deploy of app.deploys.slice(-5)) {
        this.logger.info(
          `deploy ${deploy.previous ?? '?'} → ${deploy.version ?? '?'} at ${new Date(deploy.startedAt).toISOString()}: ${deploy.live}/${deploy.total} live${deploy.complete ? ' (complete)' : ''}`,
        );
      }
      for (const loop of app.restartLoops) {
        this.logger.warning(
          `restart loop: ${loop.host} (${loop.role}) restarted ${loop.restarts} times since ${new Date(loop.since).toISOString()}`,
        );
      }
      for (const check of app.checks) {
        const related = check.exceptions
          .map((e) => `${e.class}: ${e.message} (${e.count}×)`)
          .join('; ');
        this.logger.warning(
          `${check.name}: ${check.status} for ${shortDuration(view.now - check.since)} on ${check.affected} of ${check.of}${check.message ? ` (${check.message})` : ''}${related ? ` · since then: ${related}` : ''}`,
        );
      }
    }
  }
}
