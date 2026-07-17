import { describe, expect, it, vi } from 'vitest';
import {
  type AlertChannel,
  type AlertPayload,
  Alerter,
  type ResolvedAlerts,
} from '../../src/alerts/index.js';
import type { Entry } from '../../src/entry.js';

function exceptionEntry(familyHash: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `ex-${Math.random().toString(36).slice(2)}`,
    type: 'exception',
    familyHash,
    content: {
      class: 'TypeError',
      message: 'cannot read x',
      stack: 'TypeError: cannot read x\n  at a',
      route: '/checkout',
      method: 'POST',
      statusCode: 500,
    },
    tags: ['user:42'],
    sequence: 1,
    durationMs: null,
    origin: 'http',
    traceId: null,
    createdAt: new Date(),
    ...overrides,
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
    rules: [{ type: 'new-exception', window: '1h' }],
    geoLookup: null,
    ...overrides,
  };
}

describe('Alerter — new-exception', () => {
  it('fires once for a new family and dispatches to channels with rich context', async () => {
    const { channel, payloads } = capturingChannel();
    let now = 1_000;
    const alerter = new Alerter({ alerts: resolved({ channels: [channel] }), now: () => now });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload?.rule.type).toBe('new-exception');
    expect(payload?.exception?.familyHash).toBe('fam-A');
    expect(payload?.exception?.class).toBe('TypeError');
    expect(payload?.exception?.route).toBe('/checkout');
    expect(payload?.exception?.user).toBe('42');

    // A repeat within the window does NOT re-fire.
    now += 1_000;
    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);
  });

  it('re-fires for the same family after an explicit resolveFamily', async () => {
    const { channel, payloads } = capturingChannel();
    let now = 1_000;
    const alerter = new Alerter({ alerts: resolved({ channels: [channel] }), now: () => now });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);

    alerter.resolveFamily('fam-A');
    now += 5_000;
    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(2);
  });

  it('re-fires after the window has elapsed (re-occurrence after resolved)', async () => {
    const { channel, payloads } = capturingChannel();
    let now = 1_000;
    // 1h window, but a 0 cooldown so only the window gates re-firing.
    const alerter = new Alerter({
      alerts: resolved({ channels: [channel], cooldownMs: 0 }),
      now: () => now,
    });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);

    now += 3_600_000; // exactly one window later
    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(2);
  });

  it('fires separately for distinct families', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({ alerts: resolved({ channels: [channel] }) });
    await alerter.evaluate([exceptionEntry('fam-A'), exceptionEntry('fam-B')]);
    expect(payloads).toHaveLength(2);
  });

  it('throttles re-fires of a family within the cooldown', async () => {
    const { channel, payloads } = capturingChannel();
    let now = 1_000;
    // cooldown longer than window so the cooldown is what suppresses.
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'new-exception', window: '1s' }],
        cooldownMs: 900_000,
      }),
      now: () => now,
    });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);
    // Window has elapsed (>1s), so the tracker says "new" again — but cooldown suppresses.
    now += 2_000;
    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(1);
  });

  it('ignores entries with no familyHash', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({ alerts: resolved({ channels: [channel] }) });
    await alerter.evaluate([exceptionEntry('fam-A', { familyHash: null })]);
    expect(payloads).toHaveLength(0);
  });
});

function clientExceptionEntry(familyHash: string, content: Record<string, unknown>): Entry {
  return {
    id: `cx-${Math.random().toString(36).slice(2)}`,
    type: 'client_exception',
    familyHash,
    content,
    tags: ['failed', 'client', 'user:42'],
    sequence: 1,
    durationMs: null,
    origin: 'http',
    traceId: null,
    createdAt: new Date(),
  };
}

describe('Alerter — every-exception + enrichment (d11295d)', () => {
  it('fires for EVERY exception (not just new families), throttled per-family by cooldown', async () => {
    const { channel, payloads } = capturingChannel();
    let now = 1_000;
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'every-exception' }],
        cooldownMs: 0, // no throttle: every occurrence fires
      }),
      now: () => now,
    });

    await alerter.evaluate([exceptionEntry('fam-A')]);
    now += 1;
    await alerter.evaluate([exceptionEntry('fam-A')]); // same family, fires again (new-exception would not)
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.rule.type).toBe('every-exception');
  });

  it('surfaces isNew=true on a first occurrence and isNew=false when the batch has repeats', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'every-exception' }],
        cooldownMs: 0,
      }),
      now: () => 1_000,
    });
    // Single occurrence → isNew true.
    await alerter.evaluate([exceptionEntry('fam-solo')]);
    expect(payloads.at(-1)?.exception?.isNew).toBe(true);
    // Two of the same family in one batch → occurrences 2 → isNew false.
    await alerter.evaluate([exceptionEntry('fam-dup'), exceptionEntry('fam-dup')]);
    expect(payloads.at(-1)?.exception?.occurrences).toBe(2);
    expect(payloads.at(-1)?.exception?.isNew).toBe(false);
  });

  it('keeps independent per-family cooldown clocks for new-exception and every-exception', async () => {
    const newCh = capturingChannel('new');
    // Both rules configured; a single fam-A entry should fire BOTH once.
    const alerter = new Alerter({
      alerts: resolved({
        channels: [newCh.channel],
        rules: [{ type: 'new-exception', window: '1h' }, { type: 'every-exception' }],
        cooldownMs: 900_000,
      }),
      now: () => 1_000,
    });
    await alerter.evaluate([exceptionEntry('fam-A')]);
    const types = newCh.payloads.map((p) => p.rule.type).sort();
    expect(types).toEqual(['every-exception', 'new-exception']);
  });

  it('takes a client_exception clientIp from the SERVER-filled content, never the body', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({
      alerts: resolved({ channels: [channel], rules: [{ type: 'every-exception' }] }),
    });

    await alerter.evaluate([
      clientExceptionEntry('fam-C', {
        clientIp: '203.0.113.7', // server-filled at ingest
        message: 'f.map is not a function',
        name: 'TypeError',
        url: 'https://app.example/dash',
        userAgent: 'Mozilla/5.0',
        componentStack: 'at Component',
        extra: { buildId: 'abc' },
      }),
    ]);

    const ex = payloads[0]?.exception;
    expect(ex?.client).toBe(true);
    expect(ex?.clientIp).toBe('203.0.113.7');
    expect(ex?.userAgent).toBe('Mozilla/5.0');
    expect(ex?.componentStack).toBe('at Component');
    expect(ex?.extra).toEqual({ buildId: 'abc' });
    expect(ex?.route).toBe('https://app.example/dash');
  });

  it('enriches the context with geo via the host geoLookup hook (only on a real fire)', async () => {
    const { channel, payloads } = capturingChannel();
    const geoLookup = vi.fn(async (ip: string) => ({
      city: 'São Paulo',
      region: 'SP',
      country: 'Brazil',
      countryCode: 'BR',
      ip,
    }));
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'every-exception' }],
        geoLookup,
      }),
    });

    await alerter.evaluate([clientExceptionEntry('fam-C', { clientIp: '198.51.100.9', message: 'x' })]);

    expect(geoLookup).toHaveBeenCalledWith('198.51.100.9');
    expect(payloads[0]?.exception?.geo).toMatchObject({ city: 'São Paulo', countryCode: 'BR' });
  });

  it('leaves geo null and never throws when the geoLookup hook throws', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'every-exception' }],
        geoLookup: () => {
          throw new Error('geo provider down');
        },
      }),
      logger: () => {},
    });

    await alerter.evaluate([clientExceptionEntry('fam-C', { clientIp: '198.51.100.9', message: 'x' })]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.exception?.geo).toBeNull();
  });
});

describe('Alerter — exception-rate', () => {
  it('fires when the trailing-window count crosses the threshold', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'exception-rate', window: '5m', threshold: 3 }],
      }),
    });
    await alerter.evaluate([
      exceptionEntry('fam-A'),
      exceptionEntry('fam-B'),
      exceptionEntry('fam-C'),
    ]);
    const rate = payloads.filter((p) => p.rule.type === 'exception-rate');
    expect(rate).toHaveLength(1);
    expect(rate[0]?.value).toBe(3);
  });

  it('does not fire below the threshold', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({
      alerts: resolved({
        channels: [channel],
        rules: [{ type: 'exception-rate', window: '5m', threshold: 3 }],
      }),
    });
    await alerter.evaluate([exceptionEntry('fam-A'), exceptionEntry('fam-B')]);
    expect(payloads).toHaveLength(0);
  });
});

describe('Alerter — resilience', () => {
  it('a failing channel never throws into the caller; healthy channels still receive', async () => {
    const failing: AlertChannel = {
      name: 'boom',
      send: () => Promise.reject(new Error('down')),
    };
    const { channel, payloads } = capturingChannel('ok');
    const logger = vi.fn();
    const alerter = new Alerter({
      alerts: resolved({ channels: [failing, channel] }),
      logger,
    });

    await expect(alerter.evaluate([exceptionEntry('fam-A')])).resolves.toBeUndefined();
    expect(payloads).toHaveLength(1); // healthy channel still got it
    expect(logger).toHaveBeenCalledTimes(1); // failure warn-logged once
  });

  it('does nothing when disabled', async () => {
    const { channel, payloads } = capturingChannel();
    const alerter = new Alerter({ alerts: resolved({ channels: [channel], enabled: false }) });
    await alerter.evaluate([exceptionEntry('fam-A')]);
    expect(payloads).toHaveLength(0);
  });
});
