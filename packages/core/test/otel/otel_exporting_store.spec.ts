import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { DIAGNOSTIC_ENTRY_TYPE } from '../../src/diagnostics_watcher.js';
import { createOtelExporter, type OtelExporter } from '../../src/otel/otel_exporter.js';
import { OtelExportingTelescopeStore } from '../../src/otel/otel_exporting_store.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { resetTelescopeRuntime, setTelescopePaused } from '../../src/registry.js';
import { SamplingTelescopeStore } from '../../src/sampling/sampling_store.js';
import type { TelescopeStore } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

/**
 * Builds the SAME store chain `telescope_provider.ts`'s `boot()` builds
 * (Redacting → Sampling → OtelExporting), but with a real `OtelExporter` backed
 * by IN-MEMORY OTel exporters — this is "mocking the exporter's export() call"
 * via the SDK's own standard in-memory test doubles (the exact ones
 * `@adonis-agora/durable`'s own OTel test suite uses), rather than standing up a
 * fake HTTP receiver. It exercises the real `@opentelemetry/sdk-trace-base` /
 * `sdk-logs` pipeline end-to-end (attribute/status/severity plumbing included),
 * just swapping the OTLP/HTTP network hop for an in-memory sink.
 */
function otelHarness(): {
  exporter: OtelExporter;
  spans: InMemorySpanExporter;
  logs: InMemoryLogRecordExporter;
} {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logs })],
  });
  const tracer = tracerProvider.getTracer('test');
  const logger = loggerProvider.getLogger('test');

  // A thin hand-wired `OtelExporter` reusing the SAME span/log construction the
  // real `createOtelExporter` does, but against the in-memory tracer/logger built
  // above instead of an OTLP exporter — see `createOtelExporter`'s doc for why a
  // private (non-global) tracer/logger pair is used either way.
  const exporter: OtelExporter = {
    exportSpan(input) {
      const span = tracer.startSpan(input.name, {
        startTime: input.startTimeMs,
        attributes: input.attributes,
      });
      if (input.status === 'ERROR') span.setStatus({ code: 2 });
      span.end(input.endTimeMs);
    },
    exportLog(input) {
      logger.emit({
        body: input.body,
        timestamp: input.timestampMs,
        severityNumber: input.severityNumber,
        severityText: input.severityText,
        attributes: input.attributes,
      });
    },
    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    },
  };

  return { exporter, spans, logs };
}

/**
 * `SimpleLogRecordProcessor.onEmit` exports on a floating (un-awaited) promise
 * chain — a deliberate SDK design choice ("avoid scheduling a promise to make
 * the behavior more predictable" does NOT mean synchronous, just that it isn't
 * scheduled behind resource-attribute resolution). Draining a macrotask tick
 * after `record()` lets any pending log export settle before assertions read
 * the in-memory exporter. Span export via `SimpleSpanProcessor` happens to be
 * synchronous today, but flushing here too keeps every assertion equally robust.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a `RecordInput` shaped exactly like `buildDiagnosticEntry` produces —
 * `durationMs` set from the SAME source at both the top level (the standard
 * cross-type `Entry.durationMs`) and inside `content` (for payload-viewer
 * parity), mirroring the real watcher. Pass `durationMs: undefined` in `over` to
 * build a point-in-time (durationless) entry instead.
 */
function diagnosticInput(over: { payload?: unknown; durationMs?: number | undefined } = {}) {
  const durationMs = 'durationMs' in over ? (over.durationMs ?? null) : 25;
  return {
    type: DIAGNOSTIC_ENTRY_TYPE,
    familyHash: 'billing:invoice-paid',
    content: {
      v: 1,
      lib: 'billing',
      event: 'invoice-paid',
      ts: Date.now(),
      traceId: 'a'.repeat(32),
      payload: over.payload ?? { invoiceId: 'inv_1' },
      durationMs,
    },
    tags: ['lib:billing', 'event:invoice-paid'],
    durationMs,
    traceId: 'a'.repeat(32),
  };
}

describe('OtelExportingTelescopeStore', () => {
  afterEach(() => {
    resetTelescopeRuntime();
  });

  it('exports a span for a duration-bearing diagnostic entry', async () => {
    const { exporter, spans } = otelHarness();
    const base = new InMemoryTelescopeStore();
    const store = new OtelExportingTelescopeStore(base, exporter, ['diagnostic']);

    await store.record(diagnosticInput());
    await flush();

    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.name).toBe('agora.billing.invoice-paid');
    expect(finished[0]?.attributes['agora.lib']).toBe('billing');
  });

  it('exports a log for a durationless diagnostic entry', async () => {
    const { exporter, spans, logs } = otelHarness();
    const base = new InMemoryTelescopeStore();
    const store = new OtelExportingTelescopeStore(base, exporter, ['diagnostic']);

    await store.record(diagnosticInput({ durationMs: undefined }));
    await flush();

    expect(logs.getFinishedLogRecords()).toHaveLength(1);
    expect(spans.getFinishedSpans()).toHaveLength(0);
  });

  it('does not export an entry type outside the configured entryTypes', async () => {
    const { exporter, spans, logs } = otelHarness();
    const base = new InMemoryTelescopeStore();
    const store = new OtelExportingTelescopeStore(base, exporter, ['request']); // NOT 'diagnostic'

    await store.record(diagnosticInput());
    await flush();

    expect(spans.getFinishedSpans()).toHaveLength(0);
    expect(logs.getFinishedLogRecords()).toHaveLength(0);
  });

  describe('wired into the real redaction + sampling chain', () => {
    function chain(
      inner: TelescopeStore,
      exporter: OtelExporter,
      sampling: Record<string, number>,
    ) {
      const redacted = new RedactingTelescopeStore(inner, { keys: ['secret'] });
      const sampled = new SamplingTelescopeStore(redacted, sampling, () => 0.99); // "random" always misses low rates
      return new OtelExportingTelescopeStore(sampled, exporter, ['diagnostic']);
    }

    it('exports the REDACTED content, never the raw secret', async () => {
      const { exporter, spans } = otelHarness();
      const base = new InMemoryTelescopeStore();
      const store = chain(base, exporter, {});

      await store.record(
        diagnosticInput({ payload: { invoiceId: 'inv_1', secret: 'sh-should-not-leak' } }),
      );
      await flush();

      const finished = spans.getFinishedSpans();
      expect(finished).toHaveLength(1);
      // The redacted payload's `secret` key is masked, so no attribute carries the raw value.
      const values = Object.values(finished[0]?.attributes ?? {});
      expect(values).not.toContain('sh-should-not-leak');
      expect(finished[0]?.attributes['agora.payload.secret']).toBe('[REDACTED]');
    });

    it('never exports an entry the sampling store dropped', async () => {
      const { exporter, spans, logs } = otelHarness();
      const base = new InMemoryTelescopeStore();
      // rate 0 for the diagnostic type ⇒ always dropped (random() is never < 0).
      const store = chain(base, exporter, { [DIAGNOSTIC_ENTRY_TYPE]: 0 });

      await store.record(diagnosticInput());
      await flush();

      expect(await base.count()).toBe(0); // never persisted
      expect(spans.getFinishedSpans()).toHaveLength(0);
      expect(logs.getFinishedLogRecords()).toHaveLength(0);
    });
  });

  describe('overload guard interaction', () => {
    it('skips export work while telescope is paused, but still records normally', async () => {
      const { exporter, spans } = otelHarness();
      const base = new InMemoryTelescopeStore();
      const store = new OtelExportingTelescopeStore(base, exporter, ['diagnostic']);

      setTelescopePaused(true);
      const entry = await store.record(diagnosticInput());
      await flush();

      expect(entry.sequence).toBeGreaterThanOrEqual(0); // recorded normally
      expect(await base.count()).toBe(1);
      expect(spans.getFinishedSpans()).toHaveLength(0); // but no export work started

      setTelescopePaused(false);
      await store.record(diagnosticInput());
      await flush();
      expect(spans.getFinishedSpans()).toHaveLength(1); // resumes once unpaused
    });
  });

  it('swallows a throwing exporter without breaking the write path', async () => {
    const base = new InMemoryTelescopeStore();
    const throwingExporter: OtelExporter = {
      exportSpan: () => {
        throw new Error('boom');
      },
      exportLog: () => {
        throw new Error('boom');
      },
      shutdown: async () => {},
    };
    const store = new OtelExportingTelescopeStore(base, throwingExporter, ['diagnostic']);

    await expect(store.record(diagnosticInput())).resolves.toBeDefined();
    expect(await base.count()).toBe(1);
  });
});

describe('createOtelExporter (real SDK wiring, no network)', () => {
  it('builds an exporter exposing exportSpan/exportLog/shutdown without throwing', () => {
    const exporter = createOtelExporter({
      enabled: true,
      endpoint: 'http://localhost:4318',
      tracesPath: '/v1/traces',
      logsPath: '/v1/logs',
      headers: {},
      serviceName: 'test-app',
      entryTypes: ['diagnostic'],
      timeoutMs: 1000,
    });
    expect(typeof exporter.exportSpan).toBe('function');
    expect(typeof exporter.exportLog).toBe('function');
    expect(typeof exporter.shutdown).toBe('function');
  });
});
