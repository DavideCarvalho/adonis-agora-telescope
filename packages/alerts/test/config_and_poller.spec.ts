import { InMemoryTelescopeStore } from '@agora/telescope';
import { describe, expect, it } from 'vitest';
import {
  type AlertChannel,
  type AlertPayload,
  Alerter,
  DEFAULT_RULES,
  ExceptionPoller,
  resolveConfig,
} from '../src/index.js';

describe('resolveConfig', () => {
  it('defaults to enabled with a console channel and the new-exception rule', () => {
    const config = resolveConfig();
    expect(config.enabled).toBe(true);
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]?.name).toBe('console');
    expect(config.rules).toEqual(DEFAULT_RULES);
    expect(config.intervalMs).toBe(30_000);
    expect(config.cooldownMs).toBe(900_000);
    expect(config.instanceId).toBe('telescope');
  });

  it('resolves declarative slack/webhook specs into channels', () => {
    const config = resolveConfig({
      channels: [
        { type: 'slack', url: 'https://hooks.slack.com/x' },
        { type: 'webhook', url: 'https://hook' },
      ],
    });
    expect(config.channels.map((c) => c.name)).toEqual(['slack', 'webhook']);
  });

  it('passes through a pre-built channel object', () => {
    const custom: AlertChannel = { name: 'mine', send: async () => {} };
    const config = resolveConfig({ channels: [custom] });
    expect(config.channels[0]?.name).toBe('mine');
  });

  it('normalizes durations and dashboardUrl', () => {
    const config = resolveConfig({
      every: '1m',
      cooldown: '1h',
      dashboardUrl: 'https://telescope.example/',
    });
    expect(config.intervalMs).toBe(60_000);
    expect(config.cooldownMs).toBe(3_600_000);
    expect(config.dashboardUrl).toBe('https://telescope.example/');
  });

  it('throws (fail-closed) on an unparseable rule window', () => {
    expect(() =>
      resolveConfig({ rules: [{ type: 'new-exception', window: 'eventually' }] }),
    ).toThrow(/Invalid duration/);
  });
});

describe('ExceptionPoller', () => {
  function capturing(): { channel: AlertChannel; payloads: AlertPayload[] } {
    const payloads: AlertPayload[] = [];
    return {
      payloads,
      channel: {
        name: 'capture',
        send(alert) {
          payloads.push(alert);
          return Promise.resolve();
        },
      },
    };
  }

  it('feeds only exception entries recorded after the watermark to the alerter', async () => {
    const store = new InMemoryTelescopeStore({ maxEntries: 100 });
    const { channel, payloads } = capturing();
    const alerter = new Alerter({ alerts: resolveConfig({ channels: [channel] }) });
    // Pin the boot watermark to a fixed past instant so the records below are
    // unambiguously newer than it (the store's `after` filter is strict).
    const poller = new ExceptionPoller({ store, alerter, intervalMs: 1_000, now: () => 0 });

    // Recorded after the poller's boot watermark.
    await store.record({
      type: 'exception',
      familyHash: 'fam-A',
      content: { class: 'Error', message: 'boom' },
    });
    // A non-exception entry must be ignored.
    await store.record({ type: 'request', content: { uri: '/' } });

    await poller.pollOnce();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.exception?.familyHash).toBe('fam-A');

    // A second poll with nothing new does not re-fire.
    await poller.pollOnce();
    expect(payloads).toHaveLength(1);
  });

  it('swallows a store failure (never throws into the poll loop)', async () => {
    const brokenStore = {
      record: () => Promise.resolve({} as never),
      get: () => Promise.resolve(null),
      list: () => Promise.reject(new Error('db down')),
      count: () => Promise.resolve(0),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
    };
    const { channel } = capturing();
    const alerter = new Alerter({ alerts: resolveConfig({ channels: [channel] }) });
    const logger = (): void => {};
    const poller = new ExceptionPoller({
      store: brokenStore,
      alerter,
      intervalMs: 1_000,
      logger,
    });
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });
});
