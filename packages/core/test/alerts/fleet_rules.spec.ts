import { describe, expect, it } from 'vitest';
import {
  AlerterService,
  type AlertPayload,
  type AlertRule,
  formatSlackMessage,
  resolveConfig,
} from '../../src/alerts/index.js';
import {
  type CheckState,
  FleetRegistry,
  type InstanceHeartbeat,
  MemoryFleetStore,
} from '../../src/index.js';

const MIN = 60_000;

function harness(rules: AlertRule[], cooldown = '1m') {
  let now = Date.parse('2026-11-15T12:00:00.000Z');
  const fleet = new FleetRegistry(new MemoryFleetStore(), { now: () => now });
  const sent: AlertPayload[] = [];
  const service = new AlerterService({
    alerts: resolveConfig({
      rules,
      cooldown,
      channels: [{ name: 'test', send: async (p) => void sent.push(p) }],
    }),
    metrics: { getStats: async () => ({}) as never },
    fleet: () => fleet,
    now: () => now,
    isPaused: () => false,
  });
  const beat = (app: string, id: string, overrides: Partial<InstanceHeartbeat> = {}) =>
    fleet.beat(app, {
      v: 1,
      instanceId: id,
      host: id,
      pid: 1,
      version: 'v1',
      bootedAt: new Date(now - 60 * MIN).toISOString(),
      sentAt: new Date(now).toISOString(),
      state: 'ready',
      intervalMs: 15_000,
      checks: [],
      shipping: null,
      ...overrides,
    });
  return {
    fleet,
    sent,
    service,
    beat,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

const states = (sent: AlertPayload[]) => sent.map((p) => `${p.status}:${p.fleet?.app}`);

describe('instances-up', () => {
  it('fires when an app has fewer than `below` up for `for`, resolves when they are back', async () => {
    const h = harness([{ type: 'instances-up', app: 'shop', below: 2, for: '1m' }]);
    await h.beat('shop', 'a');
    await h.beat('shop', 'b');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);

    // b stops beating: gone after 3 intervals; held for 1 minute before paging.
    h.advance(50_000);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
    h.advance(61_000);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]).toMatchObject({ value: 1, threshold: 2 });
    expect(h.sent[0]?.fleet?.detail).toBe('1 instance up (expected at least 2)');

    // Still down: deduped.
    await h.service.evaluateOnce();
    expect(h.sent).toHaveLength(1);

    await h.beat('shop', 'c');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('pages when an app has none left (below: 1), and for an app never seen', async () => {
    const h = harness([
      { type: 'instances-up', below: 1, for: '0s' },
      { type: 'instances-up', app: 'ghost', below: 1, for: '0s' },
    ]);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:ghost']);
    h.advance(10 * MIN);
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:ghost', 'firing:shop']);
    expect(h.sent[1]?.fleet?.detail).toBe('no instance is up');
  });

  it('a rolling deploy shorter than `for` does not page', async () => {
    const h = harness([{ type: 'instances-up', app: 'shop', below: 1, for: '2m' }]);
    await h.beat('shop', 'a', { state: 'draining' });
    await h.service.evaluateOnce();
    h.advance(30_000);
    await h.beat('shop', 'b');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
  });
});

describe('check-down', () => {
  const down = (since: number): CheckState => ({
    name: 'redis',
    status: 'down',
    message: 'OOM command not allowed',
    since,
    checkedAt: since,
    durationMs: 2,
    critical: true,
  });

  it('fires once the check has been down for `for`, per app and check; resolves when ok', async () => {
    const h = harness([{ type: 'check-down', check: 'redis', for: '2m' }]);
    const since = h.now();
    await h.beat('shop', 'a', { checks: [down(since)] });
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
    h.advance(3 * MIN);
    await h.beat('shop', 'a', { checks: [down(since)] });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.fleet).toMatchObject({
      check: 'redis',
      detail: 'redis: down for 3 min on 1 of 1 instance (OOM command not allowed)',
    });
    expect(h.sent[0]?.value).toBe(180);

    await h.beat('shop', 'a', { checks: [{ ...down(since), status: 'ok', since: h.now() }] });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('renders for Slack with the app, the check and the detail', async () => {
    const h = harness([{ type: 'check-down', for: '0s' }]);
    await h.beat('shop', 'a', { checks: [down(h.now() - 12 * MIN)] });
    await h.service.evaluateOnce();
    const slack = JSON.stringify(formatSlackMessage(h.sent[0] as AlertPayload));
    expect(slack).toContain('Health check down');
    expect(slack).toContain('redis: down for 12 min');
  });
});

describe('restart-loop', () => {
  it('fires when a host keeps booting, resolves once it settles', async () => {
    const h = harness([{ type: 'restart-loop' }]);
    for (const [i, m] of [5, 3, 1].entries()) {
      await h.beat('shop', `crash-${i}`, {
        host: 'web-1',
        bootedAt: new Date(h.now() - m * MIN).toISOString(),
      });
    }
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.fleet).toMatchObject({ host: 'web-1' });
    expect(h.sent[0]?.fleet?.detail).toMatch(/web-1 restarted 3 times/);
    h.advance(20 * MIN);
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });
});

describe('entries-dropped', () => {
  const shipping = (dropped: number) => ({
    buffered: 10_000,
    dropped,
    sent: 1,
    failures: 3,
    lagMs: 60_000,
    lastError: 'ECONNREFUSED',
  });

  it('fires when the instances dropped entries within the window, resolves when they stop', async () => {
    const h = harness([{ type: 'entries-dropped', window: '5m', threshold: 100 }]);
    await h.beat('shop', 'a', { shipping: shipping(1000) });
    await h.service.evaluateOnce();
    // A long-running process' first sample is a baseline, not a drop.
    expect(h.sent).toEqual([]);
    h.advance(MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.value).toBe(500);
    h.advance(6 * MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    h.advance(MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });
});

describe('config', () => {
  it('validates the fleet rules at boot', () => {
    expect(() => resolveConfig({ rules: [{ type: 'instances-up', below: 0 }] })).toThrow(/below/);
    expect(() => resolveConfig({ rules: [{ type: 'check-down', for: 'soon' }] })).toThrow(
      /Invalid duration/,
    );
    expect(() =>
      resolveConfig({ rules: [{ type: 'entries-dropped', window: '5m', threshold: 0 }] }),
    ).toThrow(/threshold/);
    expect(resolveConfig({ rules: [{ type: 'restart-loop' }] }).rules).toHaveLength(1);
  });

  it('without a fleet the fleet rules do nothing', async () => {
    const sent: AlertPayload[] = [];
    const service = new AlerterService({
      alerts: resolveConfig({
        rules: [{ type: 'instances-up', app: 'x', below: 1, for: '0s' }],
        channels: [{ name: 't', send: async (p) => void sent.push(p) }],
      }),
      metrics: { getStats: async () => ({}) as never },
      fleet: () => null,
      isPaused: () => false,
    });
    await service.evaluateOnce();
    expect(sent).toEqual([]);
  });
});
