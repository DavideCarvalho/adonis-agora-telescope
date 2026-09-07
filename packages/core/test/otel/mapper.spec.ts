import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { isValidW3cTraceId, mapEntryToOtel, resolveDurationMs } from '../../src/otel/mapper.js';

const VALID_TRACE_ID = 'a'.repeat(32);
const ALL_ZERO_TRACE_ID = '0'.repeat(32);

function diagnosticEntry(over: Partial<Entry> & { content?: Record<string, unknown> } = {}): Entry {
  const { content, ...rest } = over;
  return {
    id: 'entry_1',
    type: 'diagnostic',
    familyHash: 'billing:invoice-paid',
    content: {
      v: 1,
      lib: 'billing',
      event: 'invoice-paid',
      ts: 1_000_000,
      traceId: VALID_TRACE_ID,
      payload: { invoiceId: 'inv_1', amount: 4200 },
      durationMs: null,
      ...content,
    },
    tags: ['lib:billing', 'event:invoice-paid'],
    sequence: 1,
    durationMs: null,
    origin: 'manual',
    traceId: VALID_TRACE_ID,
    createdAt: new Date(1_000_050),
    ...rest,
  };
}

describe('isValidW3cTraceId', () => {
  it('accepts a 32-lowercase-hex trace id', () => {
    expect(isValidW3cTraceId(VALID_TRACE_ID)).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(isValidW3cTraceId(null)).toBe(false);
    expect(isValidW3cTraceId(undefined)).toBe(false);
  });

  it('rejects the all-zero trace id', () => {
    expect(isValidW3cTraceId(ALL_ZERO_TRACE_ID)).toBe(false);
  });

  it('rejects wrong length / uppercase / non-hex', () => {
    expect(isValidW3cTraceId('abc')).toBe(false);
    expect(isValidW3cTraceId(VALID_TRACE_ID.toUpperCase())).toBe(false);
    expect(isValidW3cTraceId(`${'a'.repeat(31)}z`)).toBe(false);
  });
});

describe('resolveDurationMs', () => {
  it('reads the entry-level durationMs first', () => {
    const entry = diagnosticEntry({ durationMs: 42 });
    expect(resolveDurationMs(entry)).toBe(42);
  });

  it('falls back to a numeric payload.durationMs (the durable-bridge convention)', () => {
    const entry = diagnosticEntry({
      content: { payload: { runId: 'run1', durationMs: 77 } },
    });
    expect(resolveDurationMs(entry)).toBe(77);
  });

  it('returns null when no duration is present anywhere', () => {
    const entry = diagnosticEntry();
    expect(resolveDurationMs(entry)).toBeNull();
  });

  it('ignores a negative or non-finite payload.durationMs', () => {
    const negative = diagnosticEntry({ content: { payload: { durationMs: -1 } } });
    const nan = diagnosticEntry({ content: { payload: { durationMs: Number.NaN } } });
    expect(resolveDurationMs(negative)).toBeNull();
    expect(resolveDurationMs(nan)).toBeNull();
  });
});

describe('mapEntryToOtel — span mapping (duration present)', () => {
  it('maps a durationMs entry to a SPAN with a reconstructed start time', () => {
    const entry = diagnosticEntry({ durationMs: 150, content: { ts: 2_000 } });
    const mapped = mapEntryToOtel(entry);
    expect(mapped?.kind).toBe('span');
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.name).toBe('agora.billing.invoice-paid');
    expect(mapped.span.endTimeMs).toBe(2_000);
    expect(mapped.span.startTimeMs).toBe(2_000 - 150);
    expect(mapped.span.status).toBe('OK');
    expect(mapped.span.traceId).toBe(VALID_TRACE_ID);
  });

  it('flattens scalar/array payload fields as agora.payload.* attributes', () => {
    const entry = diagnosticEntry({ durationMs: 10 });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.attributes['agora.payload.invoiceId']).toBe('inv_1');
    expect(mapped.span.attributes['agora.payload.amount']).toBe(4200);
    expect(mapped.span.attributes['agora.lib']).toBe('billing');
    expect(mapped.span.attributes['agora.event']).toBe('invoice-paid');
    expect(mapped.span.attributes['agora.entry_id']).toBe('entry_1');
  });

  it('skips a non-scalar/non-array payload field (no attribute emitted)', () => {
    const entry = diagnosticEntry({
      durationMs: 10,
      content: { payload: { nested: { a: 1 }, ok: 'yes' } },
    });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.attributes['agora.payload.nested']).toBeUndefined();
    expect(mapped.span.attributes['agora.payload.ok']).toBe('yes');
  });

  it('does not parent under a malformed trace id, but still surfaces it as a searchable attribute', () => {
    // `agora.trace_id` is a plain search/filter attribute — it stays whatever
    // `@adonis-agora/context` resolved, valid W3C shape or not. `span.traceId`
    // (used for the actual OTel parent correlation) is strictly validated, since
    // an invalid value there would corrupt the reconstructed SpanContext.
    const entry = diagnosticEntry({ durationMs: 10, traceId: 'not-a-trace-id' });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.traceId).toBeNull();
    expect(mapped.span.attributes['agora.trace_id']).toBe('not-a-trace-id');
  });

  it('marks the span ERROR via the shared isErrorEntry heuristic (tags include failed)', () => {
    const entry = diagnosticEntry({ durationMs: 10, tags: ['lib:billing', 'failed'] });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.status).toBe('ERROR');
  });

  it('marks the span ERROR via a truthy payload.error field', () => {
    const entry = diagnosticEntry({
      durationMs: 10,
      content: { event: 'step.failed', payload: { error: { message: 'boom' } } },
    });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.status).toBe('ERROR');
    expect(mapped.span.errorMessage).toBe('boom');
  });

  it('marks the span ERROR via an event name containing "failed"', () => {
    const entry = diagnosticEntry({
      durationMs: 10,
      content: { event: 'run.failed', payload: {} },
    });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.status).toBe('ERROR');
  });

  it('resolves duration from payload.durationMs (durable-bridge shape) into a span', () => {
    const entry = diagnosticEntry({
      content: {
        lib: 'durable',
        event: 'step.completed',
        ts: 5_000,
        payload: { runId: 'run1', kind: 'local', durationMs: 33 },
      },
    });
    const mapped = mapEntryToOtel(entry);
    expect(mapped?.kind).toBe('span');
    if (mapped?.kind !== 'span') throw new Error('expected span');
    expect(mapped.span.name).toBe('agora.durable.step.completed');
    expect(mapped.span.startTimeMs).toBe(5_000 - 33);
    expect(mapped.span.endTimeMs).toBe(5_000);
  });
});

describe('mapEntryToOtel — log mapping (no duration)', () => {
  it('maps a durationless entry to a LOG record', () => {
    const entry = diagnosticEntry();
    const mapped = mapEntryToOtel(entry);
    expect(mapped?.kind).toBe('log');
    if (mapped?.kind !== 'log') throw new Error('expected log');
    expect(mapped.log.body).toBe('agora.billing.invoice-paid');
    expect(mapped.log.severityText).toBe('INFO');
    expect(mapped.log.severityNumber).toBe(9);
    expect(mapped.log.traceId).toBe(VALID_TRACE_ID);
  });

  it('promotes to ERROR severity via the error heuristic', () => {
    const entry = diagnosticEntry({ tags: ['lib:billing', 'failed'] });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'log') throw new Error('expected log');
    expect(mapped.log.severityText).toBe('ERROR');
    expect(mapped.log.severityNumber).toBe(17);
  });

  it('reads an explicit payload.level to pick severity', () => {
    const entry = diagnosticEntry({ content: { payload: { level: 'warn' } } });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'log') throw new Error('expected log');
    expect(mapped.log.severityText).toBe('WARN');
    expect(mapped.log.severityNumber).toBe(13);
  });

  it('falls back to createdAt when the content has no numeric ts', () => {
    const entry = diagnosticEntry({ content: { ts: 'not-a-number' as unknown as number } });
    const mapped = mapEntryToOtel(entry);
    if (mapped?.kind !== 'log') throw new Error('expected log');
    expect(mapped.log.timestampMs).toBe(entry.createdAt.getTime());
  });
});

describe('mapEntryToOtel — uninterpretable entries', () => {
  it('returns null for content with no lib/event strings', () => {
    const entry: Entry = {
      id: 'e1',
      type: 'request',
      familyHash: null,
      content: { method: 'GET', url: '/x' },
      tags: [],
      sequence: 1,
      durationMs: 12,
      origin: 'http',
      traceId: null,
      createdAt: new Date(),
    };
    expect(mapEntryToOtel(entry)).toBeNull();
  });

  it('returns null for non-object content (e.g. a primitive)', () => {
    const entry: Entry = {
      id: 'e2',
      type: 'diagnostic',
      familyHash: null,
      content: 'not an object' as unknown,
      tags: [],
      sequence: 1,
      durationMs: null,
      origin: 'manual',
      traceId: null,
      createdAt: new Date(),
    };
    expect(mapEntryToOtel(entry)).toBeNull();
  });
});
