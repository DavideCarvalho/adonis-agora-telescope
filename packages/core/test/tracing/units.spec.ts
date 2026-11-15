import { describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig } from '../../src/define_config.js';
import type { Entry, RecordInput } from '../../src/entry.js';
import { summarizeTraces } from '../../src/metrics/traces.js';
import { buildWaterfall } from '../../src/metrics/waterfall.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { scopedStore } from '../../src/tenancy_store.js';
import { isPropagationTarget, resolvePropagation } from '../../src/tracing/config.js';
import {
  injectIntoClientRequest,
  injectIntoUndiciRequest,
  outgoingTraceHeaders,
} from '../../src/tracing/outbound.js';
import { newTraceScope, runInTraceScope } from '../../src/tracing/scope.js';
import {
  formatTraceparent,
  parseTraceparent,
  parseTracestate,
} from '../../src/tracing/traceparent.js';
import { TelescopeApi } from '../../src/ui/api.js';
import { hiddenSpansCounter } from '../../src/ui/app_scope.js';
import { makeRequest, RecordingResponse } from '../../src/ui/http.js';

const T = 'a'.repeat(32);
const S = 'b'.repeat(16);

describe('traceparent', () => {
  it('parses a valid header', () => {
    expect(parseTraceparent(`00-${T}-${S}-01`)).toEqual({ traceId: T, spanId: S, flags: '01' });
    expect(parseTraceparent([`00-${T}-${S}-00`])?.flags).toBe('00');
    expect(parseTraceparent(`00-${T.toUpperCase()}-${S}-01`)?.traceId).toBe(T);
  });

  it('rejects what the spec says to ignore', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      `00-${'0'.repeat(32)}-${S}-01`,
      `00-${T}-${'0'.repeat(16)}-01`,
      `ff-${T}-${S}-01`,
      `00-${T}-${S}-01-extra`,
      `00-${T}-${S}`,
    ]) {
      expect(parseTraceparent(bad)).toBeUndefined();
    }
    // A future version may carry more fields.
    expect(parseTraceparent(`01-${T}-${S}-01-more`)?.traceId).toBe(T);
  });

  it('keeps a printable tracestate only', () => {
    expect(parseTracestate('a=1,b=2')).toBe('a=1,b=2');
    expect(parseTracestate('a=1\r\nx: y')).toBeUndefined();
    expect(parseTracestate('x'.repeat(600))).toBeUndefined();
    expect(formatTraceparent(T, S)).toBe(`00-${T}-${S}-01`);
  });
});

describe('propagation config', () => {
  it('defaults: nothing goes out, incoming continued, queue on, node:http off', () => {
    expect(resolvePropagation(undefined)).toEqual({
      targets: [],
      incoming: true,
      nodeHttp: false,
      queue: true,
    });
    expect(resolveConfig({}).propagationConfigured).toBe(false);
    expect(resolveConfig({ propagation: {} }).propagationConfigured).toBe(true);
  });

  it('normalizes targets to origins and refuses what is not one', () => {
    expect(resolvePropagation({ targets: ['https://Billing.internal/api/v1'] }).targets).toEqual([
      'https://billing.internal',
    ]);
    expect(() => resolvePropagation({ targets: ['billing.internal'] })).toThrow(/not an http/);
    expect(() => defineConfig({ propagation: { targets: ['ftp://x'] } })).toThrow(/not an http/);
  });

  it('matches exact origins, RegExps, and all', () => {
    const { targets } = resolvePropagation({
      targets: ['http://localhost:3334', /\.internal$/],
    });
    expect(isPropagationTarget(targets, 'http://localhost:3334')).toBe(true);
    expect(isPropagationTarget(targets, 'http://localhost:3335')).toBe(false);
    expect(isPropagationTarget(targets, 'https://search.internal')).toBe(true);
    expect(isPropagationTarget(targets, 'https://api.stripe.com')).toBe(false);
    expect(isPropagationTarget('all', 'https://api.stripe.com')).toBe(true);
    expect(isPropagationTarget('all', null)).toBe(false);
  });
});

describe('outgoing headers', () => {
  const config = resolvePropagation({ targets: ['http://billing.test'] });

  it('nothing outside a trace', () => {
    expect(outgoingTraceHeaders()).toBeNull();
  });

  it('the scope’s trace and span, and the caller’s tracestate', () => {
    const scope = newTraceScope({ traceId: T, spanId: S, flags: '00' }, 'v=1');
    const headers = runInTraceScope(scope, () => outgoingTraceHeaders());
    expect(headers).toEqual({ traceparent: `00-${T}-${scope.spanId}-00`, tracestate: 'v=1' });
  });

  it('adds to an undici request to a target, once', () => {
    const added: string[][] = [];
    const request = {
      origin: 'http://billing.test',
      headers: ['accept', '*/*'],
      addHeader: (k: string, v: string) => added.push([k, v]),
    };
    runInTraceScope(newTraceScope(), () => injectIntoUndiciRequest(config, request));
    expect(added.map(([k]) => k)).toEqual(['traceparent']);
    const already = { ...request, headers: ['Traceparent', 'x'] };
    added.length = 0;
    runInTraceScope(newTraceScope(), () => injectIntoUndiciRequest(config, already));
    expect(added).toEqual([]);
    const other = { ...request, origin: 'https://api.stripe.com' };
    runInTraceScope(newTraceScope(), () => injectIntoUndiciRequest(config, other));
    expect(added).toEqual([]);
  });

  it('adds to a node:http request to a target', () => {
    const set: Record<string, string> = {};
    const request = {
      protocol: 'http:',
      getHeader: (name: string) => (name === 'host' ? 'billing.test' : set[name]),
      setHeader: (name: string, value: string) => {
        set[name] = value;
      },
    };
    runInTraceScope(newTraceScope(), () => injectIntoClientRequest(config, request));
    expect(set.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

function entry(partial: Partial<Entry> & { id: string; createdAt: Date }): Entry {
  return {
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 10,
    origin: 'http',
    traceId: T,
    ...partial,
  };
}

describe('waterfall across apps', () => {
  const at = (ms: number) => new Date(1_000_000 + ms);

  it('links by span id even when the clocks disagree', () => {
    // billing's clock runs 50ms ahead: by time alone its request would not sit inside shop's.
    const shop = entry({
      id: 'shop',
      createdAt: at(100),
      durationMs: 100,
      tags: ['app:shop'],
      content: { method: 'GET', url: '/checkout', spanId: '1'.repeat(16), parentSpanId: null },
    });
    const billing = entry({
      id: 'billing',
      createdAt: at(170),
      durationMs: 40,
      tags: ['app:billing'],
      content: {
        method: 'GET',
        url: '/charge',
        spanId: '2'.repeat(16),
        parentSpanId: '1'.repeat(16),
      },
    });
    const query = entry({
      id: 'q',
      type: 'query',
      createdAt: at(160),
      durationMs: 5,
      tags: ['app:billing'],
      content: { sql: 'select 1' },
    });
    const waterfall = buildWaterfall([shop, billing, query]);
    expect(waterfall?.apps).toEqual(['shop', 'billing']);
    expect(waterfall?.spans.map((s) => s.id)).toEqual(['shop']);
    const child = waterfall?.spans[0]?.children.find((c) => c.id === 'billing');
    expect(child?.app).toBe('billing');
    expect(child?.depth).toBe(1);
    expect(child?.children.map((c) => [c.id, c.depth])).toEqual([['q', 2]]);
  });

  it('ignores a link that would make a cycle or names an unknown span', () => {
    const a = entry({
      id: 'a',
      createdAt: at(100),
      durationMs: 100,
      content: { spanId: '1'.repeat(16), parentSpanId: '2'.repeat(16) },
    });
    const b = entry({
      id: 'b',
      createdAt: at(80),
      durationMs: 20,
      content: { spanId: '2'.repeat(16), parentSpanId: '1'.repeat(16) },
    });
    const c = entry({ id: 'c', createdAt: at(300), content: { parentSpanId: 'f'.repeat(16) } });
    const waterfall = buildWaterfall([a, b, c]);
    expect(waterfall?.spans.map((s) => s.id)).toEqual(['a', 'c']);
    expect(waterfall?.spans[0]?.children.map((s) => s.id)).toEqual(['b']);
    expect(waterfall?.apps).toEqual([]);
  });

  it('the trace list names the apps, the one that started first', () => {
    const [summary] = summarizeTraces([
      entry({ id: '2', createdAt: at(150), tags: ['app:billing'] }),
      entry({ id: '1', createdAt: at(200), durationMs: 200, tags: ['app:shop'] }),
    ]);
    expect(summary?.apps).toEqual(['shop', 'billing']);
    expect(summarizeTraces([entry({ id: '1', createdAt: at(1) })])[0]?.apps).toEqual([]);
  });
});

describe('a viewer limited to some apps', () => {
  async function seed() {
    const store = new InMemoryTelescopeStore();
    const inputs: RecordInput[] = [
      { type: 'request', content: { url: '/checkout' }, tags: ['app:shop'], traceId: T },
      { type: 'request', content: { url: '/charge' }, tags: ['app:billing'], traceId: T },
      { type: 'query', content: { sql: 'x' }, tags: ['app:billing'], traceId: T },
      {
        type: 'request',
        content: { url: '/other' },
        tags: ['app:billing'],
        traceId: 'c'.repeat(32),
      },
    ];
    for (const input of inputs) await store.record({ durationMs: 1, ...input });
    return store;
  }

  async function waterfallFor(appTags: string[] | null, traceId = T) {
    const store = await seed();
    const view = scopedStore(store, null, appTags);
    const api = new TelescopeApi(
      new TelescopeService(view),
      {},
      undefined,
      {},
      {},
      appTags === null ? undefined : hiddenSpansCounter(store, null, appTags),
    );
    const res = new RecordingResponse();
    await api.metricsWaterfall({ request: makeRequest('GET', {}), response: res }, traceId);
    return res;
  }

  it('sees its own spans and how many other apps recorded', async () => {
    const res = await waterfallFor(['app:shop']);
    const body = res.body as { data: { spans: Array<{ app: string }>; hiddenSpans: number } };
    expect(body.data.spans.map((s) => s.app)).toEqual(['shop']);
    expect(body.data.hiddenSpans).toBe(2);
  });

  it('a trace it sees nothing of is a 404, whatever others recorded', async () => {
    const res = await waterfallFor(['app:shop'], 'c'.repeat(32));
    expect(res.statusCode).toBe(404);
  });

  it('an unrestricted viewer sees every app and no note', async () => {
    const res = await waterfallFor(null);
    const body = res.body as { data: { apps: string[]; hiddenSpans?: number } };
    expect(body.data.apps.sort()).toEqual(['billing', 'shop']);
    expect(body.data.hiddenSpans).toBeUndefined();
  });

  it('counts only inside the viewer’s organizations', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {},
      tags: ['app:billing', 'tenant:acme'],
      traceId: T,
    });
    await store.record({
      type: 'request',
      content: {},
      tags: ['app:billing', 'tenant:other'],
      traceId: T,
    });
    expect(await hiddenSpansCounter(store, ['tenant:acme'], ['app:shop'])(T)).toBe(1);
  });
});
