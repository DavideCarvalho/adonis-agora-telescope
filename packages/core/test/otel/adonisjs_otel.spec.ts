import type { ApplicationService } from '@adonisjs/core/types';
import { context, logs, type Span, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TelescopeProvider from '../../providers/telescope_provider.js';
import { currentTraceId, setOtelTraceIdReader } from '../../src/context_accessor.js';
import { resolveConfig, type TelescopeConfig } from '../../src/define_config.js';
import type { Entry } from '../../src/entry.js';
import { isGlobalOtelRegistered } from '../../src/otel/detect.js';
import { createGlobalOtelEmitter, readActiveOtelTraceId } from '../../src/otel/global_emitter.js';
import { telescopeSpanProcessor } from '../../src/otel/index.js';
import { OtelEmittingTelescopeStore } from '../../src/otel/otel_emitting_store.js';
import {
  getTelescopeRuntime,
  registerEnabledWatchers,
  resetTelescopeRuntime,
  setTelescopePaused,
  setTelescopeRuntime,
  setTelescopeSelfPath,
} from '../../src/registry.js';
import { runAsTelescopeWork } from '../../src/self_scope.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

// One OpenTelemetry pipeline for the whole file, the way `@adonisjs/otel` sets it up: the
// telescope processor next to an exporter that stands in for the app's destinations.
const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const processor = telescopeSpanProcessor({ maxSpansPerTrace: 5 });
const tracerProvider = new TracerProvider({
  spanProcessors: [processor, new SimpleSpanProcessor({ exporter: spans })],
});
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
});
const contextManager = new AsyncLocalStorageContextManager();

/** A tracer reporting under `scope`, like an auto-instrumentation does. */
const tracerOf = (scope: string) => tracerProvider.getTracer(scope);

/** Let fire-and-forget records settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

let store: InMemoryTelescopeStore;

function boot(watchers: string[]) {
  store = new InMemoryTelescopeStore();
  resetTelescopeRuntime();
  setTelescopeRuntime(store, watchers.includes('request'));
  registerEnabledWatchers(watchers);
}

async function entriesOfType(type: string): Promise<Entry[]> {
  return (await store.list({})).filter((e) => e.type === type);
}

/** Run `fn` inside an active span of `scope`, then end it. */
function inSpan<T>(scope: string, name: string, fn: (span: Span) => T, kind?: number): T {
  return tracerOf(scope).startActiveSpan(name, kind === undefined ? {} : { kind }, (span) => {
    try {
      return fn(span);
    } finally {
      span.end();
    }
  });
}

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
});

afterAll(async () => {
  trace.disable();
  logs.disable();
  context.disable();
  await tracerProvider.shutdown();
  await loggerProvider.shutdown();
});

beforeEach(() => {
  spans.reset();
  logRecords.reset();
  setOtelTraceIdReader(null);
});

afterEach(() => {
  resetTelescopeRuntime();
});

describe('telescopeSpanProcessor', () => {
  it('fits the SDK span processor contract', () => {
    const asSdk: SpanProcessor = telescopeSpanProcessor();
    expect(typeof asSdk.onEnd).toBe('function');
  });

  it('ingests a span no watcher covers as a `span` entry in the same trace', async () => {
    boot(['request', 'query']);
    const traceId = inSpan('@opentelemetry/instrumentation-pg', 'pg.query:SELECT', (span) => {
      span.setAttribute('db.statement', 'select 1');
      return span.spanContext().traceId;
    });
    await settle();

    const [entry] = await entriesOfType('span');
    expect(entry?.traceId).toBe(traceId);
    expect(entry?.content).toMatchObject({
      name: 'pg.query:SELECT',
      scope: '@opentelemetry/instrumentation-pg',
      kind: 'internal',
      attributes: { 'db.statement': 'select 1' },
    });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips a knex span and the driver span under it while the query watcher is on', async () => {
    boot(['query']);
    inSpan('@opentelemetry/instrumentation-knex', 'select users', () => {
      inSpan('@opentelemetry/instrumentation-pg', 'pg.query', () => undefined);
    });
    await settle();
    expect(await entriesOfType('span')).toEqual([]);
  });

  it('ingests the knex span when the query watcher is off, so nothing is lost', async () => {
    boot(['request']);
    inSpan('@opentelemetry/instrumentation-knex', 'select users', () => undefined);
    await settle();
    expect((await entriesOfType('span')).map((e) => (e.content as { name: string }).name)).toEqual([
      'select users',
    ]);
  });

  it('skips the HTTP server span when the request watcher is on, keeps its children', async () => {
    boot(['request']);
    inSpan(
      '@opentelemetry/instrumentation-http',
      'GET /users',
      () => {
        inSpan('@adonisjs/otel', 'UsersController.index', () => undefined);
      },
      1,
    );
    await settle();
    expect((await entriesOfType('span')).map((e) => (e.content as { name: string }).name)).toEqual([
      'UsersController.index',
    ]);
  });

  it('skips the spans of a request to the dashboard', async () => {
    boot([]);
    setTelescopeSelfPath('/telescope');
    tracerOf('@opentelemetry/instrumentation-http').startActiveSpan(
      'GET',
      { kind: 1, attributes: { 'http.target': '/telescope/api/entries' } },
      (server) => {
        inSpan('@opentelemetry/instrumentation-pg', 'pg.query', () => undefined);
        server.end();
      },
    );
    await settle();
    expect(await entriesOfType('span')).toEqual([]);
  });

  it("skips telescope's own spans and anything inside telescope's own work", async () => {
    boot([]);
    inSpan('@adonis-agora/telescope', 'agora.durable.run', () => undefined);
    runAsTelescopeWork(() => inSpan('@opentelemetry/instrumentation-pg', 'INSERT', () => 0));
    await settle();
    expect(await entriesOfType('span')).toEqual([]);
  });

  it('records nothing before telescope boots or while ingestion is paused', async () => {
    resetTelescopeRuntime();
    inSpan('@opentelemetry/instrumentation-pg', 'pg.query', () => undefined);
    boot([]);
    setTelescopePaused(true);
    inSpan('@opentelemetry/instrumentation-pg', 'pg.query', () => undefined);
    setTelescopePaused(false);
    await settle();
    expect(await entriesOfType('span')).toEqual([]);
  });

  it('caps the spans one trace contributes', async () => {
    boot([]);
    inSpan('app', 'root', () => {
      for (let i = 0; i < 10; i++) inSpan('app', `child ${i}`, () => undefined);
    });
    await settle();
    expect(await entriesOfType('span')).toHaveLength(5);
  });

  it('marks a span that ended with an error as failed', async () => {
    boot([]);
    inSpan('app', 'charge', (span) => span.setStatus({ code: 2, message: 'declined' }));
    await settle();
    const [entry] = await entriesOfType('span');
    expect(entry?.tags).toContain('failed');
    expect(entry?.content).toMatchObject({ status: 'error', statusMessage: 'declined' });
  });
});

describe('trace id alignment', () => {
  it('takes the active OTel trace id for entries recorded inside a span', async () => {
    boot([]);
    setOtelTraceIdReader(readActiveOtelTraceId);
    expect(currentTraceId()).toBeNull();
    const [traceId, recorded] = await tracerOf('app').startActiveSpan('job', async (span) => {
      const entry = await store.record({ type: 'job', content: { name: 'X' } });
      span.end();
      return [span.spanContext().traceId, entry.traceId] as const;
    });
    expect(recorded).toBe(traceId);
  });
});

describe('emitting through the global providers', () => {
  function emittingStore(entryTypes = resolveConfig({}).otel.entryTypes) {
    boot(['request', 'query']);
    return new OtelEmittingTelescopeStore(store, createGlobalOtelEmitter(), entryTypes);
  }

  it('emits a timed entry as one child span of the active span', async () => {
    const emitting = emittingStore();
    const parent = await tracerOf('app').startActiveSpan('POST /checkout', async (span) => {
      await emitting.record({
        type: 'diagnostic',
        content: { lib: 'payments', event: 'charge.settled', ts: Date.now(), payload: {} },
        durationMs: 12,
      });
      span.end();
      return span.spanContext();
    });
    await settle();

    const emitted = spans
      .getFinishedSpans()
      .filter((s) => s.name === 'agora.payments.charge.settled');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.spanContext().traceId).toBe(parent.traceId);
    expect(emitted[0]?.parentSpanContext?.spanId).toBe(parent.spanId);
    expect(emitted[0]?.instrumentationScope.name).toBe('@adonis-agora/telescope');
    // The processor saw that span too, and did not bring it back into telescope.
    expect((await entriesOfType('span')).map((e) => (e.content as { name: string }).name)).toEqual([
      'POST /checkout',
    ]);
  });

  it('emits a point-in-time entry as a log record in the same trace', async () => {
    const emitting = emittingStore();
    const traceId = await tracerOf('app').startActiveSpan('GET /boom', async (span) => {
      await emitting.record({
        type: 'exception',
        content: { name: 'TypeError', message: 'nope', stack: 'at x' },
      });
      span.end();
      return span.spanContext().traceId;
    });
    const [record] = logRecords.getFinishedLogRecords();
    expect(record?.body).toBe('TypeError: nope');
    expect(record?.severityText).toBe('ERROR');
    expect(record?.attributes['exception.type']).toBe('TypeError');
    expect(record?.spanContext?.traceId).toBe(traceId);
  });

  it('annotates the HTTP span with the request entry instead of emitting another span', async () => {
    const emitting = emittingStore();
    let entryId = '';
    tracerOf('@opentelemetry/instrumentation-http').startActiveSpan(
      'GET /users',
      { kind: 1 },
      async (span) => {
        entryId = (await emitting.record({ type: 'request', content: { method: 'GET' } })).id;
        span.end();
      },
    );
    await settle();
    const finished = spans.getFinishedSpans();
    expect(finished.map((s) => s.name)).toEqual(['GET /users']);
    expect(finished[0]?.attributes['telescope.entry_id']).toBe(entryId);
  });

  it('leaves the types OTel already traces out by default', async () => {
    const emitting = emittingStore();
    await emitting.record({ type: 'query', content: { sql: 'select 1' }, durationMs: 1 });
    await emitting.record({ type: 'redis', content: { command: 'get' }, durationMs: 1 });
    await emitting.record({ type: 'log', content: { level: 'info', msg: 'hi' } });
    expect(spans.getFinishedSpans()).toEqual([]);
    expect(logRecords.getFinishedLogRecords()).toEqual([]);
  });

  it('never sends a `span` entry back, even when listed', async () => {
    const emitting = emittingStore(['span']);
    await emitting.record({ type: 'span', content: { name: 'pg.query' }, durationMs: 1 });
    expect(spans.getFinishedSpans()).toEqual([]);
  });

  it('emits nothing for a sampled-away entry or while paused', async () => {
    const emitting = emittingStore();
    setTelescopePaused(true);
    await emitting.record({ type: 'job', content: { name: 'X' }, durationMs: 3 });
    setTelescopePaused(false);
    expect(spans.getFinishedSpans()).toEqual([]);
  });
});

describe('TelescopeProvider wiring', () => {
  function fakeApp(config: TelescopeConfig): ApplicationService {
    return {
      config: { get: (key: string) => (key === 'telescope' ? config : undefined) },
      container: { singleton: () => {}, make: async () => ({}) },
    } as unknown as ApplicationService;
  }
  const base: TelescopeConfig = { watchers: ['request'], overload: { enabled: false } };

  it('detects the SDK registered globally', () => {
    expect(isGlobalOtelRegistered()).toBe(true);
  });

  it('routes entries to the app pipeline and aligns trace ids once booted', async () => {
    const provider = new TelescopeProvider(fakeApp(base));
    await provider.boot();
    const booted = getTelescopeRuntime().store;
    if (booted === null) throw new Error('telescope did not boot');
    const traceId = await tracerOf('app').startActiveSpan('job', async (span) => {
      const entry = await booted.record({ type: 'job', content: { name: 'Sync' }, durationMs: 4 });
      span.end();
      expect(entry.traceId).toBe(span.spanContext().traceId);
      return span.spanContext().traceId;
    });
    const emitted = spans.getFinishedSpans().filter((s) => s.name === 'telescope.job Sync');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.spanContext().traceId).toBe(traceId);
    await provider.shutdown();
    expect(currentTraceId()).toBeNull();
  });

  it('keeps trace ids aligned but emits nothing with otel: false', async () => {
    const provider = new TelescopeProvider(fakeApp({ ...base, otel: false }));
    await provider.boot();
    const booted = getTelescopeRuntime().store;
    if (booted === null) throw new Error('telescope did not boot');
    await tracerOf('app').startActiveSpan('job', async (span) => {
      const entry = await booted.record({ type: 'job', content: { name: 'Sync' }, durationMs: 4 });
      expect(entry.traceId).toBe(span.spanContext().traceId);
      span.end();
    });
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(['job']);
    await provider.shutdown();
  });

  it('rejects the 0.x exporter options with a pointer to config/otel.ts', () => {
    expect(() =>
      resolveConfig({
        otel: { enabled: true, endpoint: 'x' } as unknown as false,
      }),
    ).toThrow(/config\/otel\.ts/);
  });
});

describe('without an OpenTelemetry SDK', () => {
  it('records locally, with the store left unwrapped', async () => {
    trace.disable();
    try {
      expect(isGlobalOtelRegistered()).toBe(false);
      const spy = vi.spyOn(console, 'error');
      const provider = new TelescopeProvider({
        config: {
          get: () => ({
            watchers: ['request'],
            overload: { enabled: false },
            redact: { enabled: false },
            stream: { enabled: false },
          }),
        },
        container: { singleton: () => {}, make: async () => ({}) },
      } as unknown as ApplicationService);
      await provider.boot();
      const booted = getTelescopeRuntime().store;
      expect(booted).toBeInstanceOf(InMemoryTelescopeStore);
      await booted?.record({ type: 'job', content: { name: 'Sync' }, durationMs: 1 });
      expect(await booted?.count()).toBe(1);
      expect(spy).not.toHaveBeenCalled();
      await provider.shutdown();
    } finally {
      trace.setGlobalTracerProvider(tracerProvider);
    }
  });
});
