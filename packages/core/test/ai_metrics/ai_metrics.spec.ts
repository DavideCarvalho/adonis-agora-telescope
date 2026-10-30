import diagnostics_channel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { agentEventOfEntry, readRun, readUsage } from '../../src/ai_metrics/agent_events.js';
import { AgentMetricsRegistry, agentMetricPoints } from '../../src/ai_metrics/agent_metrics.js';
import { summarizeAiUsage } from '../../src/ai_metrics/ai_usage.js';
import {
  createOtelMetricsExporter,
  type MeterProviderLike,
} from '../../src/ai_metrics/otel_metrics_exporter.js';
import { subscribeAgentObservations } from '../../src/ai_metrics/subscribe.js';
import { resolveConfig } from '../../src/define_config.js';
import type { Entry } from '../../src/entry.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

const usagePayload = (over: Record<string, unknown> = {}) => ({
  actorRef: 'user:1',
  feature: 'agent:writer',
  purpose: 'chat',
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 800,
  costUsd: 0.012,
  costSource: 'provider',
  runId: 'run-1',
  threadId: 'thread-1',
  ...over,
});

const runPayload = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  threadId: 'thread-1',
  agentName: 'writer',
  actorId: 'user:1',
  steps: 2,
  inputTokens: 1200,
  outputTokens: 300,
  durationMs: 4200,
  ttftMs: 900,
  costUsd: 0.012,
  modelId: 'claude-sonnet-4-5',
  queueMs: 150,
  modelMs: 3100,
  toolsMs: 800,
  modelCalls: 2,
  toolCalls: 2,
  stepTimings: [
    {
      step: 0,
      modelMs: 1800,
      toolsMs: 800,
      tools: [
        { toolCallId: 'a', toolName: 'search_articles', ms: 650 },
        { toolCallId: 'b', toolName: 'read_note', ms: 120 },
      ],
    },
    { step: 1, modelMs: 1300, toolsMs: 0, tools: [] },
  ],
  ...over,
});

describe('agent event readers', () => {
  it('reads a priced usage row', () => {
    const u = readUsage(usagePayload());
    expect(u).toMatchObject({
      feature: 'agent:writer',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      costSource: 'provider',
      platform: false,
      costUsd: 0.012,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      requests: 1,
    });
  });

  it('marks an unpriced row with cost_source none, and the platform payer', () => {
    const u = readUsage(
      usagePayload({ actorRef: '@platform', costUsd: undefined, costSource: undefined }),
    );
    expect(u).toMatchObject({ costSource: 'none', platform: true });
    expect(u?.costUsd).toBeUndefined();
  });

  it('defaults the agent name and tolerates a run.finished without timings', () => {
    const r = readRun('run.finished', { runId: 'r', threadId: 't', steps: 1 });
    expect(r).toMatchObject({ status: 'completed', agent: 'default', stepTimings: [] });
    expect(r?.queueMs).toBeUndefined();
  });

  it('reads failed and cancelled runs', () => {
    expect(readRun('run.failed', runPayload({ code: 'model_error' }))).toMatchObject({
      status: 'failed',
      code: 'model_error',
    });
    expect(readRun('run.cancelled', { runId: 'r', durationMs: 10, queueMs: 3 })).toMatchObject({
      status: 'cancelled',
      queueMs: 3,
    });
    expect(readRun('run.started', {})).toBeNull();
  });

  it('finds the agent event in a diagnostic entry only', () => {
    expect(
      agentEventOfEntry({
        type: 'diagnostic',
        content: { lib: 'agent', event: 'usage.recorded', payload: { a: 1 } },
      }),
    ).toEqual({ event: 'usage.recorded', payload: { a: 1 } });
    expect(
      agentEventOfEntry({ type: 'diagnostic', content: { lib: 'durable', event: 'run.finished' } }),
    ).toBeNull();
    expect(
      agentEventOfEntry({ type: 'request', content: { lib: 'agent', event: 'x' } }),
    ).toBeNull();
  });
});

describe('agentMetricPoints', () => {
  it('never puts actor, run or thread on a metric', () => {
    const usage = readUsage(usagePayload());
    const run = readRun('run.finished', runPayload());
    if (usage === null || run === null) throw new Error('unreadable');
    for (const point of [...agentMetricPoints(usage), ...agentMetricPoints(run)]) {
      for (const key of Object.keys(point.attributes)) {
        expect(['actorRef', 'actor', 'runId', 'run_id', 'threadId', 'thread_id']).not.toContain(
          key,
        );
      }
    }
  });

  it('emits tokens per direction and tool durations per tool', () => {
    const usage = readUsage(usagePayload({ cacheWriteTokens: 50 }));
    const run = readRun('run.finished', runPayload());
    if (usage === null || run === null) throw new Error('unreadable');
    const tokens = agentMetricPoints(usage).filter((p) => p.metric === 'tokens');
    expect(tokens.map((p) => [p.attributes.direction, p.value])).toEqual([
      ['in', 1200],
      ['out', 300],
      ['cache_read', 800],
      ['cache_write', 50],
    ]);
    const tools = agentMetricPoints(run).filter((p) => p.metric === 'toolDurationMs');
    expect(tools.map((p) => [p.attributes.tool, p.value])).toEqual([
      ['search_articles', 650],
      ['read_note', 120],
    ]);
    const timings = agentMetricPoints(run).filter((p) => p.metric !== 'toolDurationMs');
    expect(timings.map((p) => p.metric)).toEqual([
      'runDurationMs',
      'runQueueMs',
      'runModelMs',
      'runToolsMs',
    ]);
    expect(timings[0]?.attributes).toEqual({ agent: 'writer', status: 'completed' });
  });

  it('counts an unpriced call as a request but adds no cost', () => {
    const usage = readUsage(usagePayload({ costUsd: undefined, requests: 3 }));
    if (usage === null) throw new Error('unreadable');
    const points = agentMetricPoints(usage);
    expect(points.find((p) => p.metric === 'costUsd')).toBeUndefined();
    expect(points.find((p) => p.metric === 'requests')).toMatchObject({
      value: 3,
      attributes: { cost_source: 'none' },
    });
  });
});

describe('AgentMetricsRegistry', () => {
  it('renders _total counters and cumulative histograms', () => {
    const registry = new AgentMetricsRegistry();
    const usage = readUsage(usagePayload());
    const run = readRun('run.finished', runPayload());
    if (usage === null || run === null) throw new Error('unreadable');
    registry.observe(usage);
    registry.observe(usage);
    registry.observe(run);
    const text = registry.prometheus();
    expect(text).toContain('# TYPE agora_ai_cost_usd_total counter');
    expect(text).toContain(
      'agora_ai_cost_usd_total{feature="agent:writer",model="claude-sonnet-4-5",provider="anthropic",cost_source="provider",platform="false"} 0.024',
    );
    expect(text).toContain('# TYPE agora_agent_run_duration_ms histogram');
    expect(text).toContain(
      'agora_agent_run_duration_ms_bucket{agent="writer",status="completed",le="2500"} 0',
    );
    expect(text).toContain(
      'agora_agent_run_duration_ms_bucket{agent="writer",status="completed",le="5000"} 1',
    );
    expect(text).toContain(
      'agora_agent_run_duration_ms_bucket{agent="writer",status="completed",le="+Inf"} 1',
    );
    expect(text).toContain(
      'agora_agent_run_duration_ms_sum{agent="writer",status="completed"} 4200',
    );
    expect(text).toContain('agora_agent_tool_duration_ms_count{tool="search_articles"} 1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is empty before anything is observed', () => {
    expect(new AgentMetricsRegistry().prometheus()).toBe('');
  });

  it('caps series per metric and reports the drops', () => {
    const registry = new AgentMetricsRegistry({ maxSeriesPerMetric: 1 });
    for (const feature of ['a', 'b', 'c']) {
      const u = readUsage(usagePayload({ feature }));
      if (u) registry.observe(u);
    }
    const text = registry.prometheus();
    expect(text).toContain('feature="a"');
    expect(text).not.toContain('feature="b"');
    expect(text).toContain('agora_ai_metrics_dropped_series_total{metric="agora_ai_cost_usd"} 2');
  });

  it('escapes label values', () => {
    const registry = new AgentMetricsRegistry();
    const u = readUsage(usagePayload({ feature: 'say "hi"\\n' }));
    if (u) registry.observe(u);
    expect(registry.prometheus()).toContain('feature="say \\"hi\\"\\\\n"');
  });
});

describe('subscribeAgentObservations', () => {
  it('reads envelopes from the agora:agent channels and unsubscribes', () => {
    const seen: string[] = [];
    const stop = subscribeAgentObservations((o) => seen.push(o.kind));
    const envelope = (event: string, payload: unknown) => ({
      v: 1,
      ts: Date.now(),
      lib: 'agent',
      event,
      payload,
    });
    diagnostics_channel
      .channel('agora:agent:usage.recorded')
      .publish(envelope('usage.recorded', usagePayload()));
    diagnostics_channel
      .channel('agora:agent:run.finished')
      .publish(envelope('run.finished', runPayload()));
    diagnostics_channel
      .channel('agora:agent:run.started')
      .publish(envelope('run.started', { runId: 'x' }));
    stop();
    diagnostics_channel
      .channel('agora:agent:usage.recorded')
      .publish(envelope('usage.recorded', usagePayload()));
    expect(seen).toEqual(['usage', 'run']);
  });

  it('never throws back into the publisher', () => {
    const stop = subscribeAgentObservations(() => {
      throw new Error('boom');
    });
    expect(() =>
      diagnostics_channel
        .channel('agora:agent:usage.recorded')
        .publish({ payload: usagePayload() }),
    ).not.toThrow();
    stop();
  });
});

const end = new Date('2026-10-29T12:00:00Z');
const start = new Date(end.getTime() - 3_600_000);
let seq = 0;

function diagnostic(event: string, payload: unknown, minutesAgo: number, lib = 'agent'): Entry {
  seq += 1;
  return {
    id: `e${seq}`,
    type: 'diagnostic',
    familyHash: `${lib}:${event}`,
    content: { v: 1, lib, event, ts: 0, traceId: `trace-${seq}`, payload, durationMs: null },
    tags: [`lib:${lib}`, `event:${event}`],
    sequence: seq,
    durationMs: null,
    origin: 'manual',
    traceId: `trace-${seq}`,
    createdAt: new Date(end.getTime() - minutesAgo * 60_000),
  };
}

describe('summarizeAiUsage', () => {
  const entries = [
    diagnostic('usage.recorded', usagePayload(), 50),
    diagnostic(
      'usage.recorded',
      usagePayload({
        actorRef: '@platform',
        feature: 'ficha-abnt',
        modelId: 'gpt-4.1-mini',
        provider: 'openai',
        costUsd: 0.004,
        costSource: 'estimate',
      }),
      30,
    ),
    diagnostic(
      'usage.recorded',
      usagePayload({
        feature: 'transcription',
        modelId: 'whisper-1',
        provider: 'openai',
        costUsd: undefined,
        costSource: undefined,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 90,
      }),
      10,
    ),
    diagnostic('run.finished', runPayload(), 49),
    diagnostic(
      'run.failed',
      runPayload({ runId: 'run-2', durationMs: 9000, costUsd: 0.05, code: 'tool_error' }),
      20,
    ),
    diagnostic('run.finished', { runId: 'run-old', threadId: 't', steps: 1, durationMs: 100 }, 5),
    // Outside the window.
    diagnostic('usage.recorded', usagePayload({ costUsd: 99 }), 120),
  ];
  const summary = summarizeAiUsage(entries, { windowStart: start, windowEnd: end, buckets: 6 });

  it('totals spend with the platform and estimated shares', () => {
    expect(summary.spend.totalUsd).toBeCloseTo(0.016);
    expect(summary.spend.platformUsd).toBeCloseTo(0.004);
    expect(summary.spend.estimatedUsd).toBeCloseTo(0.004);
    expect(summary.spend.calls).toBe(3);
    expect(summary.spend.unpricedCalls).toBe(1);
    expect(summary.spend.audioSeconds).toBe(90);
  });

  it('breaks spend down by feature, model and actor', () => {
    expect(summary.spend.byFeature.map((r) => r.key)).toEqual([
      'agent:writer',
      'ficha-abnt',
      'transcription',
    ]);
    expect(summary.spend.byModel[0]?.key).toBe('claude-sonnet-4-5');
    expect(summary.spend.byActor.map((r) => r.key)).toEqual(['user:1', '@platform']);
  });

  it('buckets spend over the window', () => {
    expect(summary.spend.buckets).toHaveLength(6);
    expect(summary.spend.buckets.reduce((sum, b) => sum + b.costUsd, 0)).toBeCloseTo(0.016);
  });

  it('lists runs newest first, with the slowest and the most expensive', () => {
    expect(summary.runs.map((r) => r.runId)).toEqual(['run-old', 'run-2', 'run-1']);
    expect(summary.slowest[0]?.runId).toBe('run-2');
    expect(summary.mostExpensive[0]?.runId).toBe('run-2');
    const run1 = summary.runs.find((r) => r.runId === 'run-1');
    expect(run1).toMatchObject({ queueMs: 150, modelMs: 3100, toolsMs: 800, toolCalls: 2 });
    expect(run1?.traceId).toMatch(/^trace-/);
    expect(run1?.stepTimings[0]?.tools).toHaveLength(2);
  });

  it('groups unpriced calls', () => {
    expect(summary.unpriced).toEqual([
      expect.objectContaining({
        feature: 'transcription',
        model: 'whisper-1',
        provider: 'openai',
        calls: 1,
        audioSeconds: 90,
      }),
    ]);
  });

  it('reports coverage, including runs without timings', () => {
    expect(summary.coverage).toMatchObject({
      usageEvents: 3,
      runEvents: 3,
      legacyAgentLib: false,
      runsWithoutTimings: 1,
    });
  });

  it('flags an agent lib that predates usage.recorded', () => {
    const legacy = summarizeAiUsage(
      [diagnostic('run.started', { runId: 'r' }, 5), diagnostic('run.finished', { runId: 'r' }, 4)],
      { windowStart: start, windowEnd: end },
    );
    expect(legacy.coverage.legacyAgentLib).toBe(true);
    expect(legacy.coverage.usageEvents).toBe(0);
  });
});

describe('MetricsService.getAi', () => {
  it('reads the agent entries of the window from the store', async () => {
    const store = new InMemoryTelescopeStore();
    const record = (event: string, payload: unknown) =>
      store.record({
        type: 'diagnostic',
        familyHash: `agent:${event}`,
        tags: ['lib:agent', `event:${event}`],
        content: { v: 1, lib: 'agent', event, ts: Date.now(), traceId: null, payload },
      });
    await record('usage.recorded', usagePayload());
    await record('run.finished', runPayload());
    await store.record({
      type: 'diagnostic',
      familyHash: 'durable:step.completed',
      tags: ['lib:durable'],
      content: { lib: 'durable', event: 'step.completed', payload: {} },
    });
    const ai = await new MetricsService(store).getAi({ windowMs: 3_600_000 });
    expect(ai.spend.totalUsd).toBeCloseTo(0.012);
    expect(ai.runs).toHaveLength(1);
    expect(ai.coverage.legacyAgentLib).toBe(false);
    expect(ai.truncated).toBe(false);
  });

  it('probes for other agent events when there is no usage', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'diagnostic',
      familyHash: 'agent:run.started',
      tags: ['lib:agent', 'event:run.started'],
      content: { lib: 'agent', event: 'run.started', payload: { runId: 'r' } },
    });
    const ai = await new MetricsService(store).getAi({ windowMs: 3_600_000 });
    expect(ai.coverage).toMatchObject({ agentEvents: 1, usageEvents: 0, legacyAgentLib: true });
  });

  it('rejects a bad window', async () => {
    await expect(
      new MetricsService(new InMemoryTelescopeStore()).getAi({ windowMs: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('config', () => {
  it('keeps metrics and Prometheus off by default', () => {
    const config = resolveConfig({});
    expect(config.prometheus.enabled).toBe(false);
    expect(config.otel.metrics).toMatchObject({
      enabled: false,
      url: 'http://localhost:4318/v1/metrics',
    });
  });

  it('lets metrics use their own endpoint without the traces headers', () => {
    const config = resolveConfig({
      otel: {
        enabled: true,
        endpoint: 'https://us.i.posthog.com/i',
        headers: { Authorization: 'Bearer secret' },
        metrics: { enabled: true, endpoint: 'http://localhost:4318/' },
      },
    });
    expect(config.otel.metrics.url).toBe('http://localhost:4318/v1/metrics');
    expect(config.otel.metrics.headers).toEqual({});
  });

  it('reuses the traces endpoint and headers when metrics name none', () => {
    const config = resolveConfig({
      otel: {
        endpoint: 'http://collector:4318',
        headers: { 'x-k': 'v' },
        metrics: { enabled: true },
      },
    });
    expect(config.otel.metrics.url).toBe('http://collector:4318/v1/metrics');
    expect(config.otel.metrics.headers).toEqual({ 'x-k': 'v' });
    expect(config.otel.enabled).toBe(false);
  });
});

describe('createOtelMetricsExporter', () => {
  it('creates unit-less instruments and feeds them from the agent channels', async () => {
    const calls: {
      kind: string;
      name: string;
      value?: number;
      unit?: string | undefined;
      attrs?: unknown;
    }[] = [];
    let flushed = 0;
    let shut = 0;
    const provider: MeterProviderLike = {
      getMeter: () => ({
        createCounter: (name, options) => {
          calls.push({ kind: 'create', name, unit: options?.unit });
          return {
            add: (value: number, attrs?: unknown) =>
              calls.push({ kind: 'add', name, value, attrs }),
          } as never;
        },
        createHistogram: (name, options) => {
          calls.push({ kind: 'create', name, unit: options?.unit });
          return {
            record: (value: number, attrs?: unknown) =>
              calls.push({ kind: 'record', name, value, attrs }),
          } as never;
        },
      }),
      forceFlush: async () => {
        flushed += 1;
      },
      shutdown: async () => {
        shut += 1;
      },
    };
    const config = resolveConfig({ otel: { metrics: { enabled: true } } }).otel.metrics;
    const exporter = await createOtelMetricsExporter(config, async () => provider);

    expect(calls.filter((c) => c.kind === 'create').map((c) => c.name)).toEqual([
      'agora_ai_cost_usd',
      'agora_ai_tokens',
      'agora_ai_audio_seconds',
      'agora_ai_requests',
      'agora_agent_run_duration_ms',
      'agora_agent_run_queue_ms',
      'agora_agent_run_model_ms',
      'agora_agent_run_tools_ms',
      'agora_agent_tool_duration_ms',
    ]);
    expect(calls.every((c) => c.kind !== 'create' || c.unit === '')).toBe(true);

    diagnostics_channel
      .channel('agora:agent:usage.recorded')
      .publish({ lib: 'agent', event: 'usage.recorded', payload: usagePayload() });
    expect(calls).toContainEqual(
      expect.objectContaining({ kind: 'add', name: 'agora_ai_cost_usd', value: 0.012 }),
    );

    await exporter.flush();
    await exporter.shutdown();
    const before = calls.length;
    diagnostics_channel
      .channel('agora:agent:usage.recorded')
      .publish({ lib: 'agent', event: 'usage.recorded', payload: usagePayload() });
    expect(calls.length).toBe(before);
    expect(flushed).toBe(1);
    expect(shut).toBe(1);
  });
});

describe('loadOtelMetricsSdk', () => {
  it('builds a real MeterProvider from the optional peers', async () => {
    const { loadOtelMetricsSdk } = await import('../../src/ai_metrics/otel_metrics_exporter.js');
    const config = resolveConfig({
      otel: {
        metrics: { enabled: true, endpoint: 'http://127.0.0.1:9', exportIntervalMs: 60_000 },
      },
    }).otel.metrics;
    const provider = await loadOtelMetricsSdk(config);
    const counter = provider.getMeter('test').createCounter('agora_test', { unit: '' });
    counter.add(1, { feature: 'x' });
    await provider.shutdown();
  });
});

describe('TelescopeApi.metricsAi', () => {
  it('answers the AI summary, and 400 on a bad window', async () => {
    const { TelescopeApi } = await import('../../src/ui/api.js');
    const { TelescopeService } = await import('../../src/service.js');
    const { makeRequest, RecordingResponse } = await import('../../src/ui/http.js');
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'diagnostic',
      familyHash: 'agent:usage.recorded',
      tags: ['lib:agent', 'event:usage.recorded'],
      content: { lib: 'agent', event: 'usage.recorded', payload: usagePayload() },
    });
    const api = new TelescopeApi(new TelescopeService(store));

    const ok = new RecordingResponse();
    await api.metricsAi({ request: makeRequest('GET', { windowMs: '3600000' }), response: ok });
    expect(ok.statusCode).toBe(200);
    expect((ok.body as { data: { spend: { calls: number } } }).data.spend.calls).toBe(1);

    const bad = new RecordingResponse();
    await api.metricsAi({ request: makeRequest('GET', { windowMs: '-1' }), response: bad });
    expect(bad.statusCode).toBe(400);
  });
});
