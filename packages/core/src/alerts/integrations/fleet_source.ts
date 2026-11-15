import type { FleetApp } from '../../fleet/derive.js';
import type { UptimeCheckState, UptimeCheckStatus } from './health.js';

const RANK: Record<UptimeCheckStatus, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };

/** The slice of the fleet registry this source reads. */
export interface FleetViewLike {
  view(): Promise<FleetApp[]>;
}

/**
 * Check states for every app in the fleet, one per app and check name (the worst
 * across the app's live instances), plus an `instances` state per app: `down`
 * when no instance is up or starting, `ok` otherwise. So `app:checkout` on a
 * status page, or a per-app heartbeat, goes down when the app is gone too.
 */
export async function fleetCheckStates(fleet: FleetViewLike): Promise<UptimeCheckState[]> {
  const states: UptimeCheckState[] = [];
  for (const app of await fleet.view()) {
    const live = app.instances.filter((i) => i.status === 'up' || i.status === 'starting');
    states.push(
      live.length === 0
        ? { name: 'instances', app: app.app, status: 'down', message: 'no live instances' }
        : { name: 'instances', app: app.app, status: 'ok' },
    );
    const byName = new Map<string, UptimeCheckState>();
    for (const instance of live) {
      for (const check of instance.checks) {
        const current = byName.get(check.name);
        if (current === undefined || RANK[check.status] > RANK[current.status]) {
          byName.set(check.name, {
            name: check.name,
            app: app.app,
            status: check.status,
            message: check.message,
            since: check.since,
            critical: check.critical,
          });
        }
      }
    }
    states.push(...byName.values());
  }
  return states;
}
