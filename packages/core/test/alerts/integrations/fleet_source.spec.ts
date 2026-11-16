import { afterEach, describe, expect, it } from 'vitest';
import {
  fleetCheckStates,
  HeartbeatMonitor,
  publishedCheckStates,
  statusForKey,
} from '../../../src/alerts/index.js';
import type { FleetApp } from '../../../src/fleet/derive.js';
import { getTelescopeRuntime } from '../../../src/registry.js';
import { mockFetch } from './helpers.js';

type Check = { name: string; status: 'ok' | 'warn' | 'down' | 'unknown'; critical?: boolean };

function app(
  name: string,
  instances: Array<{ status: string; checks: Check[]; role?: string }>,
): FleetApp {
  return {
    app: name,
    instances: instances.map((i) => ({
      status: i.status,
      ...(i.role !== undefined ? { role: i.role } : {}),
      checks: i.checks.map((c) => ({
        message: c.status === 'down' ? 'boom' : null,
        since: 1,
        checkedAt: 1,
        durationMs: 1,
        critical: c.critical ?? true,
        ...c,
      })),
    })),
  } as unknown as FleetApp;
}

const view = (apps: FleetApp[]) => ({ view: async () => apps });

describe('fleetCheckStates', () => {
  afterEach(() => {
    getTelescopeRuntime().fleet = null;
  });

  it('reports the worst state per app and check over live instances, plus an instances state', async () => {
    const states = await fleetCheckStates(
      view([
        app('checkout', [
          { status: 'up', checks: [{ name: 'redis', status: 'ok' }] },
          { status: 'up', checks: [{ name: 'redis', status: 'down' }] },
          { status: 'gone', checks: [{ name: 'pg', status: 'down' }] },
        ]),
        app('billing', [{ status: 'gone', checks: [{ name: 'redis', status: 'ok' }] }]),
      ]),
    );
    expect(states.map((s) => [s.app, s.name, s.status])).toEqual([
      ['checkout', 'instances', 'ok'],
      ['checkout', 'redis', 'down'],
      ['billing', 'instances', 'down'],
    ]);
    expect(statusForKey(states, 'app:billing')).toBe('down');
    expect(statusForKey(states, 'checkout/redis')).toBe('down');
  });

  it('the instances state follows the web processes; an app of workers only follows them', async () => {
    const states = await fleetCheckStates(
      view([
        app('checkout', [
          { status: 'gone', checks: [], role: 'web' },
          { status: 'up', checks: [], role: 'durable:work' },
        ]),
        app('jobs', [{ status: 'up', checks: [], role: 'queue:work' }]),
      ]),
    );
    expect(states.map((s) => [s.app, s.name, s.status])).toEqual([
      ['checkout', 'instances', 'down'],
      ['jobs', 'instances', 'ok'],
    ]);
  });

  it('is the default source when the runtime has a fleet, so per-app heartbeats follow it', async () => {
    getTelescopeRuntime().fleet = view([
      app('checkout', [{ status: 'up', checks: [{ name: 'redis', status: 'ok' }] }]),
      app('billing', [{ status: 'up', checks: [{ name: 'pg', status: 'down' }] }]),
    ]) as never;
    const source = publishedCheckStates();
    expect(source).not.toBeNull();
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        {
          provider: 'healthchecks',
          apps: { checkout: 'https://hc-ping.com/a', billing: 'https://hc-ping.com/b' },
        },
      ],
      source: source!,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({
      'healthchecks:checkout': 'ok',
      'healthchecks:billing': 'fail',
    });
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://hc-ping.com/a',
      'https://hc-ping.com/b/fail',
    ]);
  });
});
