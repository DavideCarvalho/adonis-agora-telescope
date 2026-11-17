import { describe, expect, it } from 'vitest';
import {
  FleetRegistry,
  fleetWatchers,
  InstanceReporter,
  MemoryFleetStore,
  normalizeHeartbeat,
  normalizeWatchers,
} from '../../src/index.js';
import { consoleMeta } from '../../src/ui/console_apis.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const instance = (app: string, watchers?: string[], lastSeenAt = NOW) => ({
  app,
  lastSeenAt,
  ...(watchers !== undefined ? { watchers } : {}),
});

describe('fleetWatchers (the watchers behind the entries on a control plane)', () => {
  it('is the union of every app in view plus the own process', () => {
    expect(
      fleetWatchers({
        instances: [instance('et', ['query', 'request']), instance('edu', ['queue'])],
        since: NOW - 1000,
        own: ['request', 'exception'],
      }),
    ).toEqual(['exception', 'query', 'queue', 'request']);
  });

  it('scoped to one app: only that app answers (no own process)', () => {
    expect(fleetWatchers({ instances: [instance('et', ['query'])], since: 0, own: null })).toEqual([
      'query',
    ]);
  });

  it('is unknown when an app in view never reported its watchers (an older sender)', () => {
    expect(
      fleetWatchers({
        instances: [instance('et', ['query']), instance('old')],
        since: 0,
        own: ['request'],
      }),
    ).toBeNull();
  });

  it('ignores a non-reporting instance once another instance of the same app reports', () => {
    expect(
      fleetWatchers({
        instances: [instance('et'), instance('et', ['query'])],
        since: 0,
        own: null,
      }),
    ).toEqual(['query']);
  });

  it('leaves out instances last seen before the window', () => {
    expect(
      fleetWatchers({
        instances: [instance('gone', undefined, NOW - 10_000), instance('et', ['query'])],
        since: NOW - 1000,
        own: null,
      }),
    ).toEqual(['query']);
  });

  it('is unknown with no instance and no own process, and the own list with no instance', () => {
    expect(fleetWatchers({ instances: [], since: 0, own: null })).toBeNull();
    expect(fleetWatchers({ instances: [], since: 0, own: ['request'] })).toEqual(['request']);
  });
});

describe('heartbeat watchers', () => {
  const base = {
    v: 1,
    instanceId: 'web-1',
    state: 'ready',
    bootedAt: new Date(NOW).toISOString(),
    sentAt: new Date(NOW).toISOString(),
  };

  it('are bounded, deduped and sorted; absent stays absent', () => {
    expect(
      normalizeHeartbeat({ ...base, watchers: ['query', 'query', 'a b', 7, 'request'] })?.watchers,
    ).toEqual(['query', 'request']);
    expect(normalizeHeartbeat(base)).not.toHaveProperty('watchers');
    expect(normalizeWatchers(Array.from({ length: 100 }, (_, i) => `w${i}`))).toHaveLength(64);
  });

  it('travel from the reporter to the fleet store', async () => {
    const fleet = new FleetRegistry(new MemoryFleetStore(), { now: () => NOW });
    const reporter = new InstanceReporter({
      intervalMs: 15_000,
      host: 'web-1',
      version: async () => null,
      watchers: () => ['query', 'request'],
      send: (heartbeat) => fleet.beat('et', heartbeat),
      now: () => NOW,
    });
    await reporter.beat();
    const [row] = await fleet.instances();
    expect(row?.watchers).toEqual(['query', 'request']);
  });

  it('a reporter without the option sends none', async () => {
    const reporter = new InstanceReporter({
      intervalMs: 15_000,
      host: 'web-1',
      version: async () => null,
      send: () => {},
    });
    expect(await reporter.build()).not.toHaveProperty('watchers');
  });
});

describe('consoleMeta watchers', () => {
  const apis = {
    diagnosisApi: { isConfigured: () => false },
    profilesApi: { isConfigured: () => false },
    queueManagerApi: { isConfigured: () => false },
  } as unknown as Parameters<typeof consoleMeta>[0];

  it('answers the given list, and leaves the field out when unknown', () => {
    expect(consoleMeta(apis, { watchers: ['query'] }).watchers).toEqual(['query']);
    expect(consoleMeta(apis, { watchers: null })).not.toHaveProperty('watchers');
    expect(Array.isArray(consoleMeta(apis).watchers)).toBe(true);
  });
});
