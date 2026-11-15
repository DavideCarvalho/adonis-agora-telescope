import { describe, expect, it } from 'vitest';
import {
  AlerterService,
  betterStackIncidentChannel,
  grafanaOnCallChannel,
  incidentIoChannel,
  incidentKey,
  type MetricSource,
  opsgenieChannel,
  pagerDutyChannel,
  type ResolvedAlerts,
  severityOf,
} from '../../../src/alerts/index.js';
import type { StatsResult } from '../../../src/metrics/stats.js';
import { exceptionAlert, fakeSleep, metricAlert, mockFetch } from './helpers.js';

describe('incident key and severity', () => {
  it('is the same for the firing and the resolving notification of a rule', () => {
    expect(incidentKey(metricAlert('firing'))).toBe(incidentKey(metricAlert('resolved')));
    expect(incidentKey(metricAlert())).toBe(
      'telescope:web-1:metric-threshold:request-p99-ms:gte:500:5m',
    );
  });

  it('is per app and per exception family', () => {
    const fleet = (app: string, check?: string) => ({
      ...metricAlert(),
      rule: { type: 'check-down', for: '2m' } as never,
      fleet: { app, ...(check ? { check } : {}), detail: 'Redis down for 3 min' },
    });
    expect(incidentKey(fleet('billing', 'redis'))).toBe(
      'telescope:billing:check-down:2m:check=redis',
    );
    expect(incidentKey(fleet('billing', 'redis'))).not.toBe(
      incidentKey(fleet('checkout', 'redis')),
    );
    expect(incidentKey(fleet('billing', 'redis'))).not.toBe(incidentKey(fleet('billing', 'pg')));
    expect(incidentKey(exceptionAlert())).toBe('telescope:web-1:new-exception:1h:fam-A');
  });

  it('defaults by rule kind and honours the rule override', () => {
    expect(severityOf(metricAlert())).toBe('warning');
    expect(severityOf(exceptionAlert())).toBe('error');
    const critical = metricAlert();
    critical.rule = { ...critical.rule, severity: 'critical' };
    expect(severityOf(critical)).toBe('critical');
  });
});

describe('pagerDutyChannel', () => {
  it('triggers then resolves with the same dedup_key', async () => {
    const { fetch, calls } = mockFetch();
    const channel = pagerDutyChannel({ routingKey: 'R0UTING', fetch });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));

    expect(calls[0]?.url).toBe('https://events.pagerduty.com/v2/enqueue');
    const trigger = calls[0]?.json as Record<string, any>;
    expect(trigger.event_action).toBe('trigger');
    expect(trigger.routing_key).toBe('R0UTING');
    expect(trigger.payload.severity).toBe('warning');
    expect(trigger.payload.source).toBe('web-1');
    expect(trigger.payload.summary).toContain('request-p99-ms = 812.500');
    expect(trigger.links[0].href).toBe('https://telescope.example');

    const resolve = calls[1]?.json as Record<string, any>;
    expect(resolve).toEqual({
      routing_key: 'R0UTING',
      event_action: 'resolve',
      dedup_key: trigger.dedup_key,
    });
  });

  it('retries a 5xx with backoff', async () => {
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 202 }]);
    const { sleep, delays } = fakeSleep();
    await pagerDutyChannel({ routingKey: 'k', fetch, sleep }).send(metricAlert());
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });
});

describe('fleet alerts', () => {
  it('PagerDuty uses the fleet app as source and its detail as summary', async () => {
    const { fetch, calls } = mockFetch();
    const alert = {
      ...metricAlert(),
      rule: { type: 'check-down', check: 'redis', for: '2m' } as never,
      fleet: {
        app: 'checkout',
        check: 'redis',
        detail: 'Redis down for 3 min on 2 of 2 instances',
      },
    };
    await pagerDutyChannel({ routingKey: 'k', fetch }).send(alert);
    const body = calls[0]!.json as Record<string, any>;
    expect(body.payload.source).toBe('checkout');
    expect(body.payload.severity).toBe('critical');
    expect(body.payload.summary).toBe(
      '[critical] checkout: Redis down for 3 min on 2 of 2 instances',
    );
  });
});

describe('opsgenieChannel', () => {
  it('creates with alias + priority and closes by alias', async () => {
    const { fetch, calls } = mockFetch();
    const channel = opsgenieChannel({ apiKey: 'G3NIE', region: 'eu', fetch });
    const firing = exceptionAlert();
    await channel.send(firing);
    await channel.send({ ...firing, status: 'resolved' });

    expect(calls[0]?.url).toBe('https://api.eu.opsgenie.com/v2/alerts');
    expect(calls[0]?.headers.authorization).toBe('GenieKey G3NIE');
    const body = calls[0]?.json as Record<string, any>;
    expect(body.alias).toBe(incidentKey(firing));
    expect(body.priority).toBe('P2');
    expect(body.message.length).toBeLessThanOrEqual(130);
    expect(body.tags).toEqual(['telescope', 'error']);

    expect(calls[1]?.url).toBe(
      `https://api.eu.opsgenie.com/v2/alerts/${encodeURIComponent(incidentKey(firing))}/close?identifierType=alias`,
    );
  });
});

describe('betterStackIncidentChannel', () => {
  it('creates one incident per key, then resolves it by id', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, json: { data: { id: '987' } } }]);
    const channel = betterStackIncidentChannel({
      apiToken: 'BST',
      requesterEmail: 'ops@example.com',
      fetch,
    });
    const critical = metricAlert();
    critical.rule = { ...critical.rule, severity: 'critical' };
    await channel.send(critical);
    await channel.send(critical); // still open: not paged twice
    await channel.send({ ...critical, status: 'resolved' });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://incidents.betterstack.com/api/v3/incidents');
    expect(calls[0]?.headers.authorization).toBe('Bearer BST');
    expect(calls[0]?.json).toMatchObject({
      requester_email: 'ops@example.com',
      call: true,
      sms: true,
      email: true,
    });
    expect(calls[1]?.url).toBe('https://incidents.betterstack.com/api/v3/incidents/987/resolve');
  });

  it('skips a resolve it has no incident for', async () => {
    const { fetch, calls } = mockFetch();
    await betterStackIncidentChannel({ apiToken: 't', requesterEmail: 'a@b.c', fetch }).send(
      metricAlert('resolved'),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('incidentIoChannel', () => {
  it('sends firing and resolved alert events with the dedup key', async () => {
    const { fetch, calls } = mockFetch();
    const channel = incidentIoChannel({ alertSourceConfigId: 'SRC1', token: 'IIO', fetch });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));
    expect(calls[0]?.url).toBe('https://api.incident.io/v2/alert_events/http/SRC1');
    expect(calls[0]?.headers.authorization).toBe('Bearer IIO');
    expect(calls[0]?.json).toMatchObject({
      status: 'firing',
      deduplication_key: incidentKey(metricAlert()),
      source_url: 'https://telescope.example',
    });
    expect(calls[1]?.json).toMatchObject({ status: 'resolved' });
  });
});

describe('grafanaOnCallChannel', () => {
  it('maps firing → alerting and resolved → ok under one alert_uid', async () => {
    const { fetch, calls } = mockFetch();
    const channel = grafanaOnCallChannel({
      url: 'https://oncall.example/integrations/v1/formatted_webhook/T/',
      fetch,
    });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));
    const [a, b] = calls.map((c) => c.json as Record<string, unknown>);
    expect(a?.state).toBe('alerting');
    expect(b?.state).toBe('ok');
    expect(a?.alert_uid).toBe(b?.alert_uid);
    // Only the fields the Formatted Webhook reads; severity rides in the title.
    expect(Object.keys(a ?? {}).sort()).toEqual([
      'alert_uid',
      'link_to_upstream_details',
      'message',
      'state',
      'title',
    ]);
    expect(a?.title).toMatch(/^\[warning\] /);
  });
});

describe('through the AlerterService', () => {
  const stats = (p99: number): StatsResult => ({
    type: 'request',
    windowMs: 300_000,
    total: 10,
    overTime: { windowStart: '', windowEnd: '', bucketMs: 1, buckets: [] },
    truncated: false,
    latency: { count: 10, p50: p99, p95: p99, p99, max: p99, slow: 0 },
  });
  const metrics = (queue: number[]): MetricSource => ({
    getStats: async () => stats(queue.shift() ?? 0),
  });
  const base = (channels: ResolvedAlerts['channels']): ResolvedAlerts => ({
    enabled: true,
    channels,
    dashboardUrl: null,
    intervalMs: 1000,
    cooldownMs: 0,
    instanceId: 'web-1',
    geoLookup: null,
    rules: [
      {
        type: 'metric-threshold',
        metric: 'request-p99-ms',
        window: '5m',
        comparator: 'gte',
        threshold: 500,
      },
    ],
  });

  it('pages once while firing and resolves when the metric clears', async () => {
    const { fetch, calls } = mockFetch();
    const service = new AlerterService({
      alerts: base([pagerDutyChannel({ routingKey: 'k', fetch })]),
      metrics: metrics([900, 950, 100]),
      isPaused: () => false,
    });
    await service.evaluateOnce();
    await service.evaluateOnce();
    await service.evaluateOnce();
    expect(calls.map((c) => (c.json as { event_action: string }).event_action)).toEqual([
      'trigger',
      'resolve',
    ]);
  });

  it('logs a failing channel by name, never its routing key', async () => {
    const { fetch } = mockFetch([{ status: 500 }]);
    const { sleep } = fakeSleep();
    const logs: string[] = [];
    const service = new AlerterService({
      alerts: base([pagerDutyChannel({ routingKey: 'SUPER-SECRET-KEY', fetch, sleep })]),
      metrics: metrics([900]),
      isPaused: () => false,
      logger: (m) => logs.push(m),
    });
    await service.evaluateOnce();
    expect(logs).toEqual(["Telescope alert channel 'pagerduty' failed: HTTP 500"]);
    expect(logs.join()).not.toContain('SUPER-SECRET-KEY');
  });
});
