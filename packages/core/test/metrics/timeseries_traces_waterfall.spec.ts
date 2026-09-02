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
    // `createdAt` é o instante em que a entry foi GRAVADA, e tudo aqui é gravado na
    // conclusão — a request num `finally`, a query depois de executar. Então ele é o
    // FIM do span, e os intervalos abaixo são os mesmos de sempre, escritos assim:
    //   request  [  0, 100]  -> createdAt 100, duração 100
    //   query 1  [ 10,  30]  -> createdAt  30, duração  20
    //   query 2  [ 40,  50]  -> createdAt  50, duração  10
    const entries = [
      entry({
        type: EntryType.Request,
        createdAt: new Date(100),
        durationMs: 100,
        content: { method: 'GET', url: '/' },
      }),
      entry({
        type: EntryType.Query,
        createdAt: new Date(30),
        durationMs: 20,
        content: { sql: 'select 1' },
      }),
      entry({
        type: EntryType.Query,
        createdAt: new Date(50),
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

/**
 * Reproduz um trace real de produção que estava desenhado errado:
 *
 *   redis 2.0ms · redis 1.0ms · redis 1.0ms · redis 3.0ms
 *   POST /api/webhooks/google-drive/writing  31ms      <- por último!
 *   redis 1.0ms
 *
 * A request aparecia DEPOIS dos comandos redis que ela mesma tinha feito, e nunca os
 * continha. A causa não era ordenação: era o waterfall tratar `createdAt` como início
 * do span quando ele é o FIM (toda entry é gravada na conclusão). Cada span era
 * deslocado para a direita pela própria duração — os de 1ms mal se moviam, o de 31ms
 * pulava para o fim. O desenho era plausível e a ordem, impossível.
 */
describe('buildWaterfall — createdAt é o FIM do span', () => {
  it('a request contém os comandos que ela emitiu, e vem primeiro', () => {
    seq = 0;
    // Request: [0, 31]. Os redis acontecem dentro dela e terminam antes.
    const entries = [
      entry({
        type: EntryType.Redis,
        createdAt: new Date(5),
        durationMs: 2,
        content: { command: 'GET' },
      }),
      entry({
        type: EntryType.Redis,
        createdAt: new Date(9),
        durationMs: 1,
        content: { command: 'SET' },
      }),
      entry({
        type: EntryType.Request,
        createdAt: new Date(31),
        durationMs: 31,
        content: { method: 'POST', url: '/api/webhooks/google-drive/writing' },
      }),
    ];

    const wf = buildWaterfall(entries);
    expect(wf).not.toBeNull();
    // Uma raiz só — a request — com os dois redis pendurados nela.
    expect(wf?.spans).toHaveLength(1);
    expect(wf?.spans[0]?.type).toBe(EntryType.Request);
    expect(wf?.spans[0]?.children).toHaveLength(2);
    // E ela começa no zero do trace: nada é desenhado antes da request.
    expect(wf?.spans[0]?.offsetMs).toBe(0);
  });

  it('span sem duração vira instante no seu createdAt, não desloca nada', () => {
    seq = 0;
    const wf = buildWaterfall([
      entry({ type: EntryType.Request, createdAt: new Date(10), durationMs: 10 }),
      entry({ type: EntryType.Log, createdAt: new Date(5), durationMs: null }),
    ]);
    const root = wf?.spans[0];
    expect(root?.type).toBe(EntryType.Request);
    // O log (instante em t=5) cai dentro da request [0, 10].
    expect(root?.children).toHaveLength(1);
    expect(root?.children[0]?.durationMs).toBe(0);
  });
});
