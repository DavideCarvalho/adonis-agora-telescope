import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWaterfall } from '../../src/metrics/waterfall.js';
import {
  registerEnabledWatchers,
  resetTelescopeRuntime,
  setTelescopeRuntime,
} from '../../src/registry.js';
import { runAsTelescopeWork } from '../../src/self_scope.js';
import { resolvePropagation } from '../../src/tracing/config.js';
import { installPropagation, type PropagationConfig } from '../../src/tracing/index.js';
import {
  AppTaggingStore,
  contentOf,
  type RunningApp,
  requestsTo,
  settle,
  startApp,
} from './two_apps.js';

/**
 * Two real AdonisJS apps in this process. `shop` calls `billing` with a plain `fetch` (no wrapper,
 * no header of its own), and telescope alone carries the trace across.
 */

let store: AppTaggingStore;
let stop: () => void = () => {};
const running: RunningApp[] = [];

beforeEach(() => {
  store = new AppTaggingStore();
  resetTelescopeRuntime();
  setTelescopeRuntime(store, true);
  registerEnabledWatchers(['request']);
});

afterEach(async () => {
  stop();
  stop = () => {};
  await Promise.all(running.splice(0).map((app) => app.close()));
  resetTelescopeRuntime();
});

function propagate(config: PropagationConfig) {
  stop = installPropagation(resolvePropagation(config), true);
}

/** `billing` answers with the trace headers it received. */
async function billing() {
  const app = await startApp('billing', {
    '/charge': ({ request }) => ({
      traceparent: request.header('traceparent') ?? null,
      tracestate: request.header('tracestate') ?? null,
    }),
  });
  running.push(app);
  return app;
}

/** `shop` calls `target` with a plain fetch and answers with what it got. */
async function shop(target: string, path = '/checkout') {
  const app = await startApp('shop', {
    [path]: async () => {
      const response = await fetch(target);
      return { downstream: await response.json() };
    },
  });
  running.push(app);
  return app;
}

describe('tracing across two apps', () => {
  it('one trace id end to end, the callee hanging under the caller', async () => {
    const b = await billing();
    const a = await shop(`${b.url}/charge`);
    propagate({ targets: [b.url] });

    const response = await fetch(`${a.url}/checkout`);
    const body = (await response.json()) as { downstream: { traceparent: string | null } };
    await settle();

    const [checkout] = await requestsTo(store, '/checkout');
    const [charge] = await requestsTo(store, '/charge');
    expect(checkout?.tags).toContain('app:shop');
    expect(charge?.tags).toContain('app:billing');

    // One trace id across both apps.
    expect(checkout?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(charge?.traceId).toBe(checkout?.traceId);
    // billing got a W3C traceparent naming shop's request as the parent span.
    const shopSpan = contentOf(checkout).spanId;
    expect(body.downstream.traceparent).toBe(`00-${checkout?.traceId}-${shopSpan}-01`);
    expect(contentOf(charge).parentSpanId).toBe(shopSpan);
    expect(contentOf(checkout).parentSpanId).toBeNull();

    // The central server's waterfall: one tree, an app per span.
    const trace = await store.list({ traceId: checkout?.traceId as string });
    const waterfall = buildWaterfall(trace);
    expect(waterfall?.apps).toEqual(['shop', 'billing']);
    expect(waterfall?.spans).toHaveLength(1);
    const root = waterfall?.spans[0];
    expect(root?.app).toBe('shop');
    expect(root?.children.map((c) => [c.app, c.label, c.depth])).toEqual([
      ['billing', 'GET /charge', 1],
    ]);
  });

  it('continues a trace the first app was called with, and forwards tracestate', async () => {
    const b = await billing();
    const a = await shop(`${b.url}/charge`);
    propagate({ targets: [b.url] });
    const upstream = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

    const response = await fetch(`${a.url}/checkout`, {
      headers: { traceparent: upstream, tracestate: 'vendor=1' },
    });
    const body = (await response.json()) as { downstream: { tracestate: string | null } };
    await settle();

    const [checkout] = await requestsTo(store, '/checkout');
    const [charge] = await requestsTo(store, '/charge');
    expect(checkout?.traceId).toBe('a'.repeat(32));
    expect(charge?.traceId).toBe('a'.repeat(32));
    expect(contentOf(checkout).parentSpanId).toBe('b'.repeat(16));
    expect(body.downstream.tracestate).toBe('vendor=1');
  });

  it('never sends trace headers outside the targets', async () => {
    const b = await billing();
    const a = await shop(`${b.url}/charge`);
    propagate({ targets: ['https://somewhere-else.example'] });

    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    await settle();

    expect(body.downstream.traceparent).toBeNull();
    const [checkout] = await requestsTo(store, '/checkout');
    const [charge] = await requestsTo(store, '/charge');
    expect(charge?.traceId).not.toBe(checkout?.traceId);
  });

  it('sends nothing until targets are configured', async () => {
    const b = await billing();
    const a = await shop(`${b.url}/charge`);
    propagate({});

    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    expect(body.downstream.traceparent).toBeNull();
  });

  it('leaves a traceparent the code set itself alone', async () => {
    const b = await billing();
    const own = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`;
    const a = await startApp('shop', {
      '/checkout': async () => {
        const response = await fetch(`${b.url}/charge`, { headers: { traceparent: own } });
        return { downstream: await response.json() };
      },
    });
    running.push(a);
    propagate({ targets: [b.url] });

    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    expect(body.downstream.traceparent).toBe(own);
  });

  it('never propagates telescope’s own calls', async () => {
    const b = await billing();
    const a = await startApp('shop', {
      '/checkout': async () => {
        const response = await runAsTelescopeWork(() => fetch(`${b.url}/charge`));
        return { downstream: await response.json() };
      },
    });
    running.push(a);
    propagate({ targets: [b.url] });

    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    expect(body.downstream.traceparent).toBeNull();
  });

  it('ignores an incoming traceparent with incoming: false', async () => {
    const b = await billing();
    propagate({ incoming: false });
    await fetch(`${b.url}/charge`, {
      headers: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
    });
    await settle();
    const [charge] = await requestsTo(store, '/charge');
    expect(charge?.traceId).not.toBe('a'.repeat(32));
  });

  it('continues an incoming traceparent even when propagation is not configured', async () => {
    const b = await billing();
    stop = installPropagation(resolvePropagation(undefined), false);
    await fetch(`${b.url}/charge`, {
      headers: { traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01` },
    });
    await fetch(`${b.url}/charge`);
    await settle();
    const charges = await requestsTo(store, '/charge');
    const traced = charges.find((e) => e.traceId === 'e'.repeat(32));
    expect(contentOf(traced).parentSpanId).toBe('f'.repeat(16));
    // Without a caller and without `propagation`, a request starts no trace (as before).
    expect(charges.filter((e) => e.traceId === null)).toHaveLength(1);
  });

  it('nodeHttp: true also covers http.request', async () => {
    const b = await billing();
    const a = await startApp('shop', {
      '/checkout': () =>
        new Promise((resolve, reject) => {
          const req = httpRequest(`${b.url}/charge`, (res) => {
            let raw = '';
            res.on('data', (chunk) => {
              raw += chunk;
            });
            res.on('end', () => resolve({ downstream: JSON.parse(raw) }));
          });
          req.on('error', reject);
          req.end();
        }),
    });
    running.push(a);
    propagate({ targets: [b.url], nodeHttp: true });

    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    await settle();
    const [checkout] = await requestsTo(store, '/checkout');
    expect(body.downstream.traceparent).toContain(checkout?.traceId as string);
  });

  it('without nodeHttp, http.request carries nothing', async () => {
    const b = await billing();
    propagate({ targets: [b.url] });
    const a = await startApp('shop', {
      '/checkout': () =>
        new Promise((resolve) => {
          httpRequest(`${b.url}/charge`, (res) => {
            let raw = '';
            res.on('data', (chunk) => {
              raw += chunk;
            });
            res.on('end', () => resolve({ downstream: JSON.parse(raw) }));
          }).end();
        }),
    });
    running.push(a);
    const body = (await (await fetch(`${a.url}/checkout`)).json()) as {
      downstream: { traceparent: string | null };
    };
    expect(body.downstream.traceparent).toBeNull();
  });
});
