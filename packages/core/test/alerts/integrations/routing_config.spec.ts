import { describe, expect, it } from 'vitest';
import {
  type AlertChannel,
  AlerterService,
  type AlertPayload,
  type MetricSource,
  resolveConfig,
  routesTo,
} from '../../../src/alerts/index.js';
import type { StatsResult } from '../../../src/metrics/stats.js';
import { metricAlert } from './helpers.js';

const capture = (name: string, minSeverity?: AlertChannel['minSeverity']) => {
  const got: AlertPayload[] = [];
  const channel: AlertChannel = {
    name,
    ...(minSeverity !== undefined ? { minSeverity } : {}),
    send: async (a) => {
      got.push(a);
    },
  };
  return { channel, got };
};

describe('routing', () => {
  it('a rule `channels` list picks channels by name', () => {
    const alert = metricAlert();
    alert.rule = { ...alert.rule, channels: ['pager'] };
    expect(routesTo(alert, capture('pager').channel)).toBe(true);
    expect(routesTo(alert, capture('slack').channel)).toBe(false);
  });

  it('a channel `minSeverity` drops less urgent alerts', () => {
    const warning = metricAlert();
    const critical = metricAlert();
    critical.rule = { ...critical.rule, severity: 'critical' };
    const pager = capture('pager', 'critical').channel;
    expect(routesTo(warning, pager)).toBe(false);
    expect(routesTo(critical, pager)).toBe(true);
  });

  it('the AlerterService only dispatches to routed channels', async () => {
    const pager = capture('pagerduty', 'critical');
    const chat = capture('discord');
    const stats: StatsResult = {
      type: 'request',
      windowMs: 1,
      total: 1,
      overTime: { windowStart: '', windowEnd: '', bucketMs: 1, buckets: [] },
      truncated: false,
      latency: { count: 5, p50: 900, p95: 900, p99: 900, max: 900, slow: 5 },
    };
    const metrics: MetricSource = { getStats: async () => stats };
    const service = new AlerterService({
      alerts: {
        ...resolveConfig({ channels: [] }, () => {}),
        channels: [pager.channel, chat.channel],
        rules: [
          {
            type: 'metric-threshold',
            metric: 'request-p99-ms',
            window: '5m',
            comparator: 'gte',
            threshold: 500,
          },
          {
            type: 'metric-threshold',
            metric: 'request-p95-ms',
            window: '5m',
            comparator: 'gte',
            threshold: 500,
            severity: 'critical',
            channels: ['pagerduty'],
          },
        ],
      },
      metrics,
      isPaused: () => false,
    });
    await service.evaluateOnce();
    expect(pager.got.map((a) => a.metric)).toEqual(['request-p95-ms']);
    expect(chat.got.map((a) => a.metric)).toEqual(['request-p99-ms']);
  });
});

describe('resolveConfig — integration specs', () => {
  it('builds every declarative channel type with its name and minSeverity', () => {
    const resolved = resolveConfig(
      {
        channels: [
          { type: 'pagerduty', routingKey: 'k', minSeverity: 'critical' },
          { type: 'opsgenie', apiKey: 'k' },
          { type: 'betterstack', apiToken: 't', requesterEmail: 'a@b.c' },
          { type: 'incident-io', alertSourceConfigId: 'c', token: 't' },
          { type: 'grafana-oncall', url: 'https://g.example' },
          { type: 'discord', url: 'https://d.example', name: 'ops-discord' },
          { type: 'teams', url: 'https://t.example' },
          { type: 'telegram', botToken: 'b', chatId: 1 },
          { type: 'google-chat', url: 'https://c.example' },
          { type: 'email', to: 'a@b.c' },
          { type: 'slack', url: 'https://s.example' },
          { type: 'webhook', url: 'https://w.example' },
        ],
      },
      () => {},
    );
    expect(resolved.channels.map((c) => c.name)).toEqual([
      'pagerduty',
      'opsgenie',
      'betterstack',
      'incident-io',
      'grafana-oncall',
      'ops-discord',
      'teams',
      'telegram',
      'google-chat',
      'email',
      'slack',
      'webhook',
    ]);
    expect(resolved.channels[0]?.minSeverity).toBe('critical');
  });

  it('skips a channel whose env secret is missing, naming the field but not values', () => {
    const warnings: string[] = [];
    const resolved = resolveConfig(
      {
        channels: [
          { type: 'pagerduty', routingKey: undefined },
          { type: 'telegram', botToken: 'PRESENT-TOKEN', chatId: '' },
          { type: 'webhook', url: 'https://w.example' },
        ],
        heartbeats: [
          { provider: 'healthchecks', url: undefined },
          { provider: 'uptimerobot', apps: { a: 'https://h.example/a', b: '' } },
        ],
        statusPages: [
          { provider: 'statuspage', apiKey: '', pageId: 'p', components: { '*': 'c' } },
        ],
      },
      (m) => warnings.push(m),
    );
    expect(resolved.channels.map((c) => c.name)).toEqual(['webhook']);
    expect(resolved.heartbeats).toEqual([
      { provider: 'uptimerobot', apps: { a: 'https://h.example/a' } },
    ]);
    expect(resolved.statusPages).toEqual([]);
    expect(warnings).toEqual([
      "Telescope alert channel 'pagerduty' is disabled: missing routingKey",
      "Telescope alert channel 'telegram' is disabled: missing chatId",
      "Telescope heartbeat 'healthchecks' is disabled: missing url",
      "Telescope heartbeat 'uptimerobot' skips app 'b': missing url",
      "Telescope status page 'statuspage' is disabled: missing apiKey",
    ]);
    expect(warnings.join()).not.toContain('PRESENT-TOKEN');
  });

  it('fails closed on a bad heartbeat cadence', () => {
    expect(() =>
      resolveConfig(
        { heartbeats: [{ provider: 'url', url: 'https://x', every: 'soon' }] },
        () => {},
      ),
    ).toThrow();
  });
});
