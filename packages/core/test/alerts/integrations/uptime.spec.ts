import { afterEach, describe, expect, it } from 'vitest';
import {
  type UptimeCheckState as CheckState,
  componentStatuses,
  HeartbeatMonitor,
  heartbeatRequests,
  publishCheckStates,
  publishedCheckStates,
  StatusPageSync,
  statusForKey,
  type UptimeHttpContext,
  uptimeEndpoint,
  uptimeResponse,
} from '../../../src/alerts/index.js';
import { getTelescopeRuntime } from '../../../src/registry.js';
import { fakeSleep, mockFetch } from './helpers.js';

const up = (name: string, app?: string): CheckState => ({
  name,
  status: 'ok',
  ...(app ? { app } : {}),
});
const down = (name: string, app?: string, message = 'boom'): CheckState => ({
  name,
  status: 'down',
  message,
  ...(app ? { app } : {}),
});

describe('heartbeat provider URLs', () => {
  it('healthchecks.io: ping, /fail, /start (query kept)', () => {
    const r = heartbeatRequests('healthchecks', 'https://hc-ping.com/uuid?rid=1', 'redis down');
    expect(r.ok.url).toBe('https://hc-ping.com/uuid?rid=1');
    expect(r.fail?.url).toBe('https://hc-ping.com/uuid/fail?rid=1');
    expect(r.fail?.body).toBe('redis down');
    expect(r.start?.url).toBe('https://hc-ping.com/uuid/start?rid=1');
  });

  it('Better Stack: GET ping, POST /fail', () => {
    const r = heartbeatRequests(
      'betterstack',
      'https://uptime.betterstack.com/api/v1/heartbeat/T',
      'x',
    );
    expect(r.ok).toMatchObject({ method: 'GET' });
    expect(r.fail?.url).toBe('https://uptime.betterstack.com/api/v1/heartbeat/T/fail');
  });

  it('Cronitor: state=complete|fail|run', () => {
    const r = heartbeatRequests('cronitor', 'https://cronitor.link/p/KEY/web', 'redis down');
    expect(r.ok.url).toBe('https://cronitor.link/p/KEY/web?state=complete');
    expect(r.fail?.url).toBe('https://cronitor.link/p/KEY/web?state=fail&message=redis+down');
    expect(r.start?.url).toBe('https://cronitor.link/p/KEY/web?state=run');
  });

  it('Uptime Kuma: status=up|down replaces the push URL params', () => {
    const r = heartbeatRequests(
      'uptime-kuma',
      'https://kuma.example/api/push/T?status=up&msg=OK&ping=',
      'db down',
    );
    expect(r.ok.url).toBe('https://kuma.example/api/push/T?status=up&msg=OK&ping=');
    expect(r.fail?.url).toBe('https://kuma.example/api/push/T?status=down&msg=db+down&ping=');
  });

  it('UptimeRobot and plain URLs have no fail signal unless given one', () => {
    expect(
      heartbeatRequests('uptimerobot', 'https://heartbeat.uptimerobot.com/X', '').fail,
    ).toBeNull();
    expect(heartbeatRequests('url', 'https://x/ok', '').fail).toBeNull();
    expect(heartbeatRequests('url', 'https://x/ok', '', 'https://x/fail').fail?.url).toBe(
      'https://x/fail',
    );
  });
});

describe('HeartbeatMonitor', () => {
  it('pings while healthy and sends /fail when a check is down', async () => {
    let states: CheckState[] = [up('redis'), up('postgres')];
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/u', every: '60s' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ healthchecks: 'ok' });
    expect(calls[0]?.url).toBe('https://hc-ping.com/u');

    expect(await monitor.tick(30_000)).toEqual({}); // not due yet

    states = [up('postgres'), down('redis', undefined, 'OOM')];
    expect(await monitor.tick(60_000)).toEqual({ healthchecks: 'fail' });
    expect(calls[1]?.url).toBe('https://hc-ping.com/u/fail');
    expect(calls[1]?.body).toBe('redis down: OOM');
  });

  it('skips (no request) when unhealthy and the provider has no fail signal', async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'uptimerobot', url: 'https://heartbeat.uptimerobot.com/X' }],
      source: () => [down('redis')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ uptimerobot: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it("onUnhealthy: 'skip' lets the grace period run out instead of failing", async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/u', onUnhealthy: 'skip' }],
      source: () => [down('redis')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ healthchecks: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('a degraded check still pings', async () => {
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'betterstack', url: 'https://b.example/hb/T' }],
      source: () => [{ name: 'disk', status: 'warn' }],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ betterstack: 'ok' });
  });

  it('a failing source is treated as unhealthy', async () => {
    const { fetch, calls } = mockFetch();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'betterstack', url: 'https://b.example/hb/T' }],
      source: () => {
        throw new Error('checks exploded');
      },
      fetch,
      logger: (m) => logs.push(m),
    });
    expect(await monitor.tick(0)).toEqual({ betterstack: 'fail' });
    expect(calls[0]?.url).toBe('https://b.example/hb/T/fail');
    expect(logs[0]).toContain('checks exploded');
  });

  it('per-app URLs on a control plane follow each app, and a silent app is not vouched for', async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        {
          provider: 'uptime-kuma',
          apps: {
            checkout: 'https://kuma.example/api/push/A',
            billing: 'https://kuma.example/api/push/B',
            ghost: 'https://kuma.example/api/push/C',
          },
        },
      ],
      source: () => [up('redis', 'checkout'), down('postgres', 'billing')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({
      'uptime-kuma:checkout': 'ok',
      'uptime-kuma:billing': 'fail',
      'uptime-kuma:ghost': 'fail',
    });
    const byToken = Object.fromEntries(
      calls.map((c) => [new URL(c.url).pathname, new URL(c.url).searchParams.get('status')]),
    );
    expect(byToken).toEqual({
      '/api/push/A': 'up',
      '/api/push/B': 'down',
      '/api/push/C': 'down',
    });
  });

  it('`checks` limits which checks count', async () => {
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok', checks: ['postgres'] }],
      source: () => [up('postgres'), down('mailer')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
  });

  it('sends the start signal once and warns once per failing target, without the URL', async () => {
    const { fetch, calls } = mockFetch([{ status: 200 }, { status: 500 }]);
    const { sleep } = fakeSleep();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        {
          provider: 'healthchecks',
          url: 'https://hc-ping.com/SECRET-UUID',
          signalStart: true,
          every: '1s',
        },
      ],
      source: () => [],
      fetch,
      sleep,
      logger: (m) => logs.push(m),
    });
    await monitor.tick(0);
    await monitor.tick(1000);
    expect(calls[0]?.url).toBe('https://hc-ping.com/SECRET-UUID/start');
    expect(calls.filter((c) => c.url.endsWith('/start'))).toHaveLength(1);
    expect(logs).toEqual(["Telescope heartbeat 'healthchecks' failed: HTTP 500"]);
  });
});

describe('status page mapping', () => {
  const states = [
    up('redis', 'checkout'),
    down('postgres', 'checkout'),
    up('redis', 'billing'),
    { name: 'disk', status: 'warn' as const, app: 'billing' },
  ];

  it('resolves check, app:, app/check and * keys', () => {
    expect(statusForKey(states, 'redis')).toBe('up');
    expect(statusForKey(states, 'postgres')).toBe('down');
    expect(statusForKey(states, 'app:billing')).toBe('degraded');
    expect(statusForKey(states, 'checkout/redis')).toBe('up');
    expect(statusForKey(states, '*')).toBe('down');
    expect(statusForKey(states, 'nope')).toBeNull();
  });

  it('several keys on one component take the worst', () => {
    const map = componentStatuses(states, {
      redis: 'C1',
      'app:billing': 'C1',
      'checkout/redis': 'C2',
      nope: 'C3',
    });
    expect([...map]).toEqual([
      ['C1', 'degraded'],
      ['C2', 'up'],
    ]);
  });
});

describe('StatusPageSync', () => {
  it('Atlassian Statuspage: PATCHes only changed components, opens and resolves an incident', async () => {
    let states: CheckState[] = [up('redis'), up('postgres')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'inc-1' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'statuspage',
          apiKey: 'SP-KEY',
          pageId: 'PAGE',
          components: { redis: 'cRedis', postgres: 'cPg' },
          incidents: true,
          every: '30s',
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls.map((c) => [c.method, c.url, (c.json as any).component?.status])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cRedis', 'operational'],
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg', 'operational'],
    ]);
    expect(calls[0]?.headers.authorization).toBe('OAuth SP-KEY');

    now = 30_000;
    await sync.tick(); // nothing changed
    expect(calls).toHaveLength(2);

    now = 60_000;
    states = [up('redis'), down('postgres', undefined, 'timeout')];
    await sync.tick();
    expect(calls.slice(2).map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg'],
      ['POST', 'https://api.statuspage.io/v1/pages/PAGE/incidents'],
    ]);
    expect((calls[2]!.json as any).component.status).toBe('major_outage');
    expect((calls[3]!.json as any).incident).toMatchObject({
      status: 'investigating',
      component_ids: ['cPg'],
      components: { cPg: 'major_outage' },
      body: 'Affected: postgres down: timeout',
    });

    now = 90_000;
    states = [up('redis'), up('postgres')];
    await sync.tick();
    expect(calls.slice(4).map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg'],
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/incidents/inc-1'],
    ]);
    expect((calls[5]!.json as any).incident).toMatchObject({
      status: 'resolved',
      components: { cPg: 'operational' },
    });
  });

  it('Instatus: PUTs component status and opens/resolves an incident', async () => {
    let states: CheckState[] = [down('api', 'checkout')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'i9' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'instatus',
          apiKey: 'IN',
          pageId: 'P',
          components: { 'app:checkout': 'cmp' },
          incidents: true,
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.instatus.com/v1/P/components/cmp',
    });
    expect(calls[0]?.json).toEqual({ status: 'MAJOROUTAGE' });
    expect(calls[1]?.url).toBe('https://api.instatus.com/v1/P/incidents');
    expect(calls[1]?.json).toMatchObject({ status: 'INVESTIGATING', components: ['cmp'] });

    now = 60_000;
    states = [up('api', 'checkout')];
    await sync.tick();
    expect(calls[2]?.json).toEqual({ status: 'OPERATIONAL' });
    expect(calls[3]?.url).toBe('https://api.instatus.com/v1/P/incidents/i9/incident-updates');
    expect(calls[3]?.json).toMatchObject({
      status: 'RESOLVED',
      statuses: [{ id: 'cmp', status: 'OPERATIONAL' }],
    });
  });

  it('Better Stack: opens a status report and resolves it with a status update', async () => {
    let states: CheckState[] = [up('redis')];
    const { fetch, calls } = mockFetch([{ status: 201, json: { data: { id: '55' } } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'betterstack',
          apiToken: 'BS',
          statusPageId: 'SP',
          components: { redis: '777' },
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls).toHaveLength(0); // healthy: nothing to report

    now = 60_000;
    states = [down('redis')];
    await sync.tick();
    expect(calls[0]?.url).toBe(
      'https://uptime.betterstack.com/api/v2/status-pages/SP/status-reports',
    );
    expect(calls[0]?.json).toMatchObject({
      report_type: 'manual',
      affected_resources: [{ status_page_resource_id: '777', status: 'downtime' }],
    });

    now = 120_000;
    await sync.tick(); // unchanged
    expect(calls).toHaveLength(1);

    now = 180_000;
    states = [up('redis')];
    await sync.tick();
    expect(calls[1]?.url).toBe(
      'https://uptime.betterstack.com/api/v2/status-pages/SP/status-reports/55/status-updates',
    );
    expect(calls[1]?.json).toMatchObject({
      affected_resources: [{ status_page_resource_id: '777', status: 'resolved' }],
    });
  });

  it('leaves pages alone when health is unknown, and retries a failed update next tick', async () => {
    let fail = true;
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    let now = 0;
    const logs: string[] = [];
    const sync = new StatusPageSync({
      statusPages: [
        { provider: 'statuspage', apiKey: 'K', pageId: 'P', components: { redis: 'c' } },
      ],
      source: () => {
        if (fail) throw new Error('no idea');
        return [down('redis')];
      },
      fetch,
      sleep,
      now: () => now,
      logger: (m) => logs.push(m),
    });
    await sync.tick();
    expect(calls).toHaveLength(0);
    fail = false;
    now = 60_000;
    await sync.tick(); // 500 twice (1 retry) → logged, not remembered
    now = 120_000;
    await sync.tick(); // retried and sent
    expect(calls).toHaveLength(3);
    expect(logs.filter((l) => l.includes("status page 'statuspage'"))).toEqual([
      "Telescope status page 'statuspage' sync failed: HTTP 500",
    ]);
  });
});

describe('uptime endpoint (pull)', () => {
  afterEach(() => publishCheckStates(null));

  function ctx(qs: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const res: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    const context: UptimeHttpContext = {
      request: { qs: () => qs, header: (name) => headers[name] ?? null },
      response: {
        status: (code) => (res.status = code),
        json: (body) => (res.body = body),
        header: (name, value) => (res.headers[name] = value),
      },
    };
    return { context, res };
  }

  it('maps up → 200, degraded → 200 (configurable), down → 503', () => {
    expect(uptimeResponse([up('a')]).statusCode).toBe(200);
    expect(uptimeResponse([{ name: 'a', status: 'warn' }]).statusCode).toBe(200);
    expect(
      uptimeResponse([{ name: 'a', status: 'warn' }], { degradedStatusCode: 503 }).statusCode,
    ).toBe(503);
    expect(uptimeResponse([down('a')]).statusCode).toBe(503);
    expect(uptimeResponse([up('a', 'x')], { app: 'y' }).body.status).toBe('down');
  });

  it('requires the token (query or header) and shows details only then', async () => {
    const handler = uptimeEndpoint({ source: () => [up('redis'), down('pg')], token: 'tok' });
    const anonymous = ctx();
    await handler(anonymous.context);
    expect(anonymous.res.status).toBe(401);

    const viaQuery = ctx({ token: 'tok' });
    await handler(viaQuery.context);
    expect(viaQuery.res.status).toBe(503);
    expect(viaQuery.res.body.status).toBe('down');
    expect(viaQuery.res.body.checks).toHaveLength(2);
    expect(viaQuery.res.headers['cache-control']).toBe('no-store');

    const viaHeader = ctx({}, { 'x-telescope-health-token': 'tok' });
    await handler(viaHeader.context);
    expect(viaHeader.res.status).toBe(503);
  });

  it('an open endpoint answers status only; ?app scopes; the published source is the default', async () => {
    publishCheckStates(() => [up('redis', 'checkout'), down('pg', 'billing')]);
    const handler = uptimeEndpoint({});
    const one = ctx({ app: 'checkout' });
    await handler(one.context);
    expect(one.res.status).toBe(200);
    expect(one.res.body).toMatchObject({ status: 'up', app: 'checkout' });
    expect(one.res.body.checks).toBeUndefined();
  });

  it('answers 503 when no source is published or it throws', async () => {
    const r = ctx();
    await uptimeEndpoint({})(r.context);
    expect(r.res.status).toBe(503);
  });
});

describe('check-state vocabulary', () => {
  afterEach(() => {
    publishCheckStates(null);
    (getTelescopeRuntime() as unknown as { healthChecks?: unknown }).healthChecks = undefined;
  });

  it('a non-critical down check keeps the heartbeat green but still moves its component', async () => {
    const { fetch } = mockFetch();
    const states: CheckState[] = [up('postgres'), { ...down('mailer'), critical: false }];
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
    expect(statusForKey(states, 'mailer')).toBe('down');
    expect(uptimeResponse(states).statusCode).toBe(200);
  });

  it('`unknown` (not run yet) neither fails a heartbeat nor moves a component', async () => {
    const states: CheckState[] = [{ name: 'redis', status: 'unknown' }];
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
    expect(statusForKey(states, 'redis')).toBeNull();
  });

  it("falls back to the runtime's health checks when nothing is published", async () => {
    expect(publishedCheckStates()).toBeNull();
    (getTelescopeRuntime() as unknown as { healthChecks?: unknown }).healthChecks = {
      states: () => [down('redis')],
    };
    const r = ctxless();
    await uptimeEndpoint({})(r.context);
    expect(r.res.status).toBe(503);
  });
});

function ctxless() {
  const res: { status?: number; body?: unknown } = {};
  const context: UptimeHttpContext = {
    request: { qs: () => ({}), header: () => null },
    response: { status: (code) => (res.status = code), json: (body) => (res.body = body) },
  };
  return { context, res };
}
