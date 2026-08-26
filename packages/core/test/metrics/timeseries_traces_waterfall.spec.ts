import { describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../../src/entry.js';
import { bucketTimeseries } from '../../src/metrics/timeseries.js';
import { summarizeTraces } from '../../src/metrics/traces.js';
import { buildWaterfall } from '../../src/metrics/waterfall.js';

let seq = 0;
function entry(over: Partial<Entry>): Entry {
  return {
    id: `id-${seq++}`,
    type: EntryType.Request,
    familyHash: null,
    content: {},
    tags: [],
    sequence: seq,
    durationMs: null,
    origin: 'http',
    traceId: 't',
    createdAt: new Date(0),
    ...over,
  };
}

describe('bucketTimeseries', () => {
  it('counts total + per-type into equal buckets', () => {
    seq = 0;
    const start = new Date(0);
    const end = new Date(10_000);
    const entries = [
      entry({ type: 'request', createdAt: new Date(1_000) }),
      entry({ type: 'request', createdAt: new Date(2_000) }),
      entry({ type: 'query', createdAt: new Date(6_000) }),
    ];
    const report = bucketTimeseries(entries, start, end, 2);
    expect(report.buckets).toHaveLength(2);
    expect(report.buckets[0]?.total).toBe(2);
    expect(report.buckets[0]?.byType.request).toBe(2);
    expect(report.buckets[1]?.total).toBe(1);
    expect(report.buckets[1]?.byType.query).toBe(1);
  });

  it('clamps out-of-range entries into edge buckets', () => {
    seq = 0;
    const start = new Date(1_000);
    const end = new Date(2_000);
    const entries = [
      entry({ createdAt: new Date(0) }), // before window → bucket 0
      entry({ createdAt: new Date(9_999) }), // after window → last bucket
    ];
    const report = bucketTimeseries(entries, start, end, 1);
    expect(report.buckets[0]?.total).toBe(2);
  });
});

describe('summarizeTraces', () => {
  it('groups by traceId with counts, types, duration and root label', () => {
    seq = 0;
    const entries = [
      entry({
        traceId: 'a',
        type: EntryType.Request,
        durationMs: 20,
        createdAt: new Date(1_000),
        content: { method: 'GET', url: '/users' },
      }),
      entry({ traceId: 'a', type: EntryType.Query, durationMs: 5, createdAt: new Date(1_010) }),
      entry({ traceId: 'b', type: EntryType.Request, durationMs: 30, createdAt: new Date(2_000) }),
      entry({ traceId: null, createdAt: new Date(3_000) }), // skipped
    ];
    const traces = summarizeTraces(entries);
    expect(traces.map((t) => t.traceId)).toEqual(['b', 'a']); // by lastAt desc
    const a = traces.find((t) => t.traceId === 'a');
    expect(a?.entryCount).toBe(2);
    expect(a?.types).toEqual([EntryType.Query, EntryType.Request].sort());
    expect(a?.totalDurationMs).toBe(25);
    expect(a?.rootLabel).toBe('GET /users');
  });

  it('carries the request entry user label onto the trace summary', () => {
    seq = 0;
    const entries = [
      entry({
        traceId: 'trace-u',
        type: EntryType.Request,
        content: { method: 'GET', url: '/me', user: { id: '42', email: 'ada@example.com' } },
      }),
      entry({ traceId: 'trace-u', type: EntryType.Query }),
    ];
    const [summary] = summarizeTraces(entries);
    expect(summary?.userLabel).toBe('ada@example.com');
  });

  it('falls back to the user id on the trace summary when email is missing', () => {
    seq = 0;
    const entries = [
      entry({
        traceId: 'trace-u1',
        type: EntryType.Request,
        content: { method: 'GET', url: '/me', user: { id: 'u-1' } },
      }),
      entry({ traceId: 'trace-u1', type: EntryType.Query }),
    ];
    const [summary] = summarizeTraces(entries);
    expect(summary?.userLabel).toBe('u-1');
  });
});

describe('buildWaterfall', () => {
  it('returns null for empty input', () => {
    expect(buildWaterfall([])).toBeNull();
  });

  it('nests by time-interval containment', () => {
    seq = 0;
    const entries = [
      entry({
        type: EntryType.Request,
        createdAt: new Date(0),
        durationMs: 100,
        content: { method: 'GET', url: '/' },
      }),
      entry({
        type: EntryType.Query,
        createdAt: new Date(10),
        durationMs: 20,
        content: { sql: 'select 1' },
      }),
      entry({
        type: EntryType.Query,
        createdAt: new Date(40),
        durationMs: 10,
        content: { sql: 'select 2' },
      }),
    ];
    const wf = buildWaterfall(entries);
    expect(wf).not.toBeNull();
    expect(wf?.spans).toHaveLength(1); // single root = the request
    const root = wf?.spans[0];
    expect(root?.type).toBe(EntryType.Request);
    expect(root?.children).toHaveLength(2);
    expect(root?.children[0]?.depth).toBe(1);
    expect(root?.label).toBe('GET /');
    expect(wf?.totalDurationMs).toBe(100);
  });

  it('treats two identical intervals as siblings, not nested', () => {
    seq = 0;
    const entries = [
      entry({ createdAt: new Date(0), durationMs: 10 }),
      entry({ createdAt: new Date(0), durationMs: 10 }),
    ];
    const wf = buildWaterfall(entries);
    expect(wf?.spans).toHaveLength(2);
  });

  it('labels diagnostics span entries as lib:event (not the bare "diagnostic" type)', () => {
    seq = 0;
    const wf = buildWaterfall([
      entry({
        id: 'd1',
        type: EntryType.Diagnostic,
        createdAt: new Date(0),
        durationMs: 100,
        content: { lib: 'agent', event: 'llm.turn', spanId: 'x-1', phase: 'asyncEnd' },
      }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    expect(wf.spans[0]?.label).toBe('agent:llm.turn');
  });
});
