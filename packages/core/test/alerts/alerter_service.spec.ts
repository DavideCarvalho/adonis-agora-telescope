import { describe, expect, it, vi } from 'vitest';
import {
  type AlertChannel,
  type AlertPayload,
  AlerterService,
  type MetricSource,
  type ResolvedAlerts,
  slackChannel,
} from '../../src/alerts/index.js';
import type { StatsResult } from '../../src/metrics/stats.js';

/** A mutable injectable clock (ms) for deterministic window/cooldown timing. */
class FakeClock {
  ms = 1_000;
  readonly now = (): number => this.ms;
  advance(byMs: number): void {
    this.ms += byMs;
  }
}

/** Minimal-but-valid {@link StatsResult}; override just the fields a test needs. */
function stats(overrides: Partial<StatsResult> = {}): StatsResult {
  return {
    type: 'request',
    windowMs: 300_000,
    total: 0,
    overTime: { windowStart: '', windowEnd: '', bucketMs: 1, buckets: [] },
    truncated: false,
    ...overrides,
  };
}

/** A metric source that yields a queued `StatsResult` per `getStats` call. */
function queuedMetrics(queue: StatsResult[]): MetricSource {
  return {
    getStats() {
      return Promise.resolve(queue.shift() ?? stats());
    },
  };
}

/** A capturing channel + the payloads it received. */
function capturingChannel(name = 'capture'): {
  channel: AlertChannel;
  payloads: AlertPayload[];
} {
  const payloads: AlertPayload[] = [];
  return {
    payloads,
    channel: {
      name,
      send(alert) {
        payloads.push(alert);
        return Promise.resolve();
      },
    },
  };
}

function resolved(overrides: Partial<ResolvedAlerts> = {}): ResolvedAlerts {
  return {
    enabled: true,
    channels: [],
    dashboardUrl: null,
    intervalMs: 1_000,
    cooldownMs: 900_000,
    instanceId: 'host-1',
    rules: [
      { type: 'metric-threshold', metric: 'request-p99-ms', window: '5m', comparator: 'gte', threshold: 500 },
    ],
    ...overrides,
  };
}

const latency = (p99: number, count = 10) => ({
  count,
  p50: p99 / 2,
  p95: p99,
  p99,
  max: p99,
  slow: count,
});

describe('AlerterService — metric-threshold raise/resolve', () => {
  it('raises + dispatches once when a percentile metric crosses the threshold', async () => {
    const { channel, payloads } = capturingChannel();
    const clock = new FakeClock();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel] }),
      metrics: queuedMetrics([stats({ latency: latency(800) })]),
      now: clock.now,
      isPaused: () => false,
    });

    await service.evaluateOnce();

    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload?.status).toBe('firing');
    expect(payload?.metric).toBe('request-p99-ms');
    expect(payload?.value).toBe(800);
    expect(payload?.threshold).toBe(500);
    expect(service.activeAlerts).toBe(1);
  });

  it('does not fire below the threshold', async () => {
    const { channel, payloads } = capturingChannel();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel] }),
      metrics: queuedMetrics([stats({ latency: latency(120) })]),
      isPaused: () => false,
    });
    await service.evaluateOnce();
    expect(payloads).toHaveLength(0);
    expect(service.activeAlerts).toBe(0);
  });

  it('auto-resolves when the condition clears, dispatching a resolved payload', async () => {
    const { channel, payloads } = capturingChannel();
    const clock = new FakeClock();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel], cooldownMs: 0 }),
      metrics: queuedMetrics([
        stats({ latency: latency(800) }), // tick 1: crosses → raise
        stats({ latency: latency(90) }), // tick 2: clears → resolve
      ]),
      now: clock.now,
      isPaused: () => false,
    });

    await service.evaluateOnce();
    clock.advance(1_000);
    await service.evaluateOnce();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.status).toBe('firing');
    expect(payloads[1]?.status).toBe('resolved');
    expect(payloads[1]?.value).toBe(90);
    expect(service.activeAlerts).toBe(0);
  });

  it('dedups: no duplicate raise while the alert stays active', async () => {
    const { channel, payloads } = capturingChannel();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel] }),
      metrics: queuedMetrics([
        stats({ latency: latency(800) }),
        stats({ latency: latency(900) }),
        stats({ latency: latency(700) }),
      ]),
      isPaused: () => false,
    });

    await service.evaluateOnce();
    await service.evaluateOnce();
    await service.evaluateOnce();

    expect(payloads.filter((p) => p.status === 'firing')).toHaveLength(1);
  });

  it('holds a resolved rule down for the cooldown before it can re-raise (flap control)', async () => {
    const { channel, payloads } = capturingChannel();
    const clock = new FakeClock();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel], cooldownMs: 60_000 }),
      metrics: queuedMetrics([
        stats({ latency: latency(800) }), // raise
        stats({ latency: latency(90) }), // resolve @ t=1s
        stats({ latency: latency(800) }), // re-cross @ t=2s — still within 60s cooldown
        stats({ latency: latency(800) }), // re-cross @ t=61.001s — past cooldown → re-raise
      ]),
      now: clock.now,
      isPaused: () => false,
    });

    await service.evaluateOnce(); // raise
    clock.advance(1_000);
    await service.evaluateOnce(); // resolve
    clock.advance(1_000);
    await service.evaluateOnce(); // suppressed by cooldown
    expect(payloads.filter((p) => p.status === 'firing')).toHaveLength(1);

    clock.advance(60_000);
    await service.evaluateOnce(); // past cooldown → re-raise
    expect(payloads.filter((p) => p.status === 'firing')).toHaveLength(2);
  });

  it('does not dispatch while the host is paused (overload shedding)', async () => {
    const { channel, payloads } = capturingChannel();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel] }),
      metrics: queuedMetrics([stats({ latency: latency(800) })]),
      isPaused: () => true,
    });
    await service.evaluateOnce();
    expect(payloads).toHaveLength(0);
    expect(service.activeAlerts).toBe(0);
  });

  it('does nothing when disabled', async () => {
    const { channel, payloads } = capturingChannel();
    const service = new AlerterService({
      alerts: resolved({ channels: [channel], enabled: false }),
      metrics: queuedMetrics([stats({ latency: latency(800) })]),
      isPaused: () => false,
    });
    await service.evaluateOnce();
    expect(payloads).toHaveLength(0);
  });
});

describe('AlerterService — cache-hit-rate + exception-count metrics', () => {
  it('fires an lte cache-hit-rate rule and resolves when the ratio recovers', async () => {
    const { channel, payloads } = capturingChannel();
    const clock = new FakeClock();
    const service = new AlerterService({
      alerts: resolved({
        channels: [channel],
        cooldownMs: 0,
        rules: [
          { type: 'metric-threshold', metric: 'cache-hit-rate', window: '5m', comparator: 'lte', threshold: 0.8 },
        ],
      }),
      metrics: queuedMetrics([
        stats({
          type: 'cache',
          cache: { hits: 60, misses: 40, sets: 0, hitRatio: 0.6, topKeys: [] },
        }),
        stats({
          type: 'cache',
          cache: { hits: 95, misses: 5, sets: 0, hitRatio: 0.95, topKeys: [] },
        }),
      ]),
      now: clock.now,
      isPaused: () => false,
    });

    await service.evaluateOnce();
    clock.advance(1_000);
    await service.evaluateOnce();

    expect(payloads.map((p) => p.status)).toEqual(['firing', 'resolved']);
  });

  it('auto-resolves an exception-count spike even when the count drops to zero', async () => {
    const { channel, payloads } = capturingChannel();
    const clock = new FakeClock();
    const service = new AlerterService({
      alerts: resolved({
        channels: [channel],
        cooldownMs: 0,
        rules: [
          { type: 'metric-threshold', metric: 'exception-count', window: '5m', comparator: 'gte', threshold: 5 },
        ],
      }),
      metrics: queuedMetrics([
        stats({ type: 'exception', total: 8 }), // spike → raise
        stats({ type: 'exception', total: 0 }), // empty window → resolve (count 0 is valid)
      ]),
      now: clock.now,
      isPaused: () => false,
    });

    await service.evaluateOnce();
    clock.advance(1_000);
    await service.evaluateOnce();

    expect(payloads.map((p) => p.status)).toEqual(['firing', 'resolved']);
  });
});

describe('AlerterService — channel dispatch', () => {
  it('renders a Slack Block Kit card via the slack channel + mock fetch', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined));
    const service = new AlerterService({
      alerts: resolved({
        channels: [slackChannel('https://hooks.slack/x', undefined, fetchMock)],
        dashboardUrl: 'https://telescope.example/',
      }),
      metrics: queuedMetrics([stats({ latency: latency(800) })]),
      isPaused: () => false,
    });

    await service.evaluateOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.slack/x');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.blocks[0].type).toBe('header');
    expect(body.blocks[0].text.text).toContain('Metric threshold (request-p99-ms)');
    expect(body.text).toContain('Metric threshold');
    // Observed-vs-threshold context field is present.
    const fieldsBlock = body.blocks.find((b: { type: string }) => b.type === 'section' && 'fields' in b);
    const fieldText = JSON.stringify(fieldsBlock.fields);
    expect(fieldText).toContain('800 (threshold 500)');
  });

  it('a failing channel never throws; healthy channels still receive', async () => {
    const failing: AlertChannel = { name: 'boom', send: () => Promise.reject(new Error('down')) };
    const { channel, payloads } = capturingChannel('ok');
    const logger = vi.fn();
    const service = new AlerterService({
      alerts: resolved({ channels: [failing, channel] }),
      metrics: queuedMetrics([stats({ latency: latency(800) })]),
      logger,
      isPaused: () => false,
    });

    await expect(service.evaluateOnce()).resolves.toBeUndefined();
    expect(payloads).toHaveLength(1);
    expect(logger).toHaveBeenCalledTimes(1);
  });
});
