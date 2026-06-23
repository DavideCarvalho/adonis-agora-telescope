import { describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../../src/entry.js';
import { LATENCY_BOUNDARIES_MS } from '../../src/metrics/rollup.js';
import { estimateLatencyPercentiles, percentile, summarizeStats } from '../../src/metrics/stats.js';

let seq = 0;
function entry(
  type: string,
  createdAt: Date,
  durationMs: number | null,
  over: Partial<Entry> = {},
): Entry {
  return {
    id: `${type}-${seq++}`,
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: seq,
    durationMs,
    origin: 'http',
    traceId: 't',
    createdAt,
    ...over,
  };
}

/** The widest boundary gap up to value `v`'s bucket — worst-case tolerance for a
 *  bucket-resolution percentile estimate of `v`. */
function bucketWidthAround(value: number): number {
  let previous = 0;
  for (const boundary of LATENCY_BOUNDARIES_MS) {
    if (value <= boundary) return boundary - previous;
    previous = boundary;
  }
  const last = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;
  const secondLast = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 2] ?? 0;
  return last - secondLast;
}

describe('percentile (nearest-rank)', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('matches the nearest-rank rule', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 0.95)).toBe(50);
    expect(percentile(sorted, 0)).toBe(10);
  });
});

describe('stats percentile histogram/raw-scan equivalence', () => {
  it('agrees on p50/p95/p99 within one bucket-width', () => {
    seq = 0;
    const now = Date.now();
    const entries: Entry[] = [];
    for (let i = 0; i < 300; i += 1) {
      const duration = ((i * 53) % 4000) + 1; // 1..4000
      entries.push(entry(EntryType.Request, new Date(now - (i % 50) * 1000), duration));
    }
    const windowStart = new Date(now - 120_000);
    const windowEnd = new Date(now);
    const durations = entries.map((e) => e.durationMs).filter((d): d is number => d !== null);

    const raw = summarizeStats({
      entries,
      type: EntryType.Request,
      windowStart,
      windowEnd,
      windowMs: 120_000,
      buckets: 2,
      slowMs: 100,
      truncated: false,
    });
    const histo = summarizeStats({
      entries,
      type: EntryType.Request,
      windowStart,
      windowEnd,
      windowMs: 120_000,
      buckets: 2,
      slowMs: 100,
      truncated: false,
      latencyPercentiles: estimateLatencyPercentiles(durations),
    });

    expect(raw.latency).toBeDefined();
    expect(histo.latency).toBeDefined();
    const rawL = raw.latency;
    const histoL = histo.latency;
    if (rawL === undefined || histoL === undefined) throw new Error('no latency');

    // count/max/slow stay raw-derived and must match exactly.
    expect(histoL.count).toBe(rawL.count);
    expect(histoL.max).toBe(rawL.max);
    expect(histoL.slow).toBe(rawL.slow);

    expect(Math.abs(histoL.p50 - rawL.p50)).toBeLessThanOrEqual(bucketWidthAround(rawL.p50));
    expect(Math.abs(histoL.p95 - rawL.p95)).toBeLessThanOrEqual(bucketWidthAround(rawL.p95));
    expect(Math.abs(histoL.p99 - rawL.p99)).toBeLessThanOrEqual(bucketWidthAround(rawL.p99));
  });

  it('never reports a percentile above max (clamped to exact max)', () => {
    seq = 0;
    const now = Date.now();
    const entries = [
      entry(EntryType.Request, new Date(now - 1_000), 300),
      entry(EntryType.Request, new Date(now - 2_000), 410),
      entry(EntryType.Request, new Date(now - 3_000), 260),
    ];
    const durations = [300, 410, 260];
    const histo = summarizeStats({
      entries,
      type: EntryType.Request,
      windowStart: new Date(now - 60_000),
      windowEnd: new Date(now),
      windowMs: 60_000,
      buckets: 1,
      slowMs: 100,
      truncated: false,
      latencyPercentiles: estimateLatencyPercentiles(durations),
    });
    const l = histo.latency;
    if (l === undefined) throw new Error('no latency');
    expect(l.max).toBe(410);
    expect(l.p50).toBeLessThanOrEqual(l.max);
    expect(l.p95).toBeLessThanOrEqual(l.max);
    expect(l.p99).toBeLessThanOrEqual(l.max);
  });

  it('leaves latency absent when there are no durationMs samples (shape parity)', () => {
    seq = 0;
    const now = Date.now();
    const entries = [
      entry(EntryType.Request, new Date(now - 5_000), null),
      entry(EntryType.Request, new Date(now - 4_000), null),
    ];
    expect(estimateLatencyPercentiles([])).toBeUndefined();
    const histo = summarizeStats({
      entries,
      type: EntryType.Request,
      windowStart: new Date(now - 60_000),
      windowEnd: new Date(now),
      windowMs: 60_000,
      buckets: 1,
      slowMs: 100,
      truncated: false,
      latencyPercentiles: estimateLatencyPercentiles([]),
    });
    expect(histo.latency).toBeUndefined();
  });
});

describe('summarizeStats per-type breakdowns', () => {
  it('computes request status breakdown (Adonis `status` field)', () => {
    seq = 0;
    const now = Date.now();
    const entries = [
      entry(EntryType.Request, new Date(now), 10, { content: { status: 200 } }),
      entry(EntryType.Request, new Date(now), 10, { content: { status: 404 } }),
      entry(EntryType.Request, new Date(now), 10, { content: { status: 503 } }),
    ];
    const result = summarizeStats({
      entries,
      type: EntryType.Request,
      windowStart: new Date(now - 1000),
      windowEnd: new Date(now + 1000),
      windowMs: 2000,
      buckets: 1,
      slowMs: 100,
      truncated: false,
    });
    expect(result.status).toEqual({ '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 1, other: 0 });
  });

  it('computes query family latency breakdown', () => {
    seq = 0;
    const now = Date.now();
    const entries = [
      entry(EntryType.Query, new Date(now), 50, {
        familyHash: 'fast',
        content: { sql: 'select 1' },
      }),
      entry(EntryType.Query, new Date(now), 500, {
        familyHash: 'slow',
        content: { sql: 'select 2' },
      }),
    ];
    const result = summarizeStats({
      entries,
      type: EntryType.Query,
      windowStart: new Date(now - 1000),
      windowEnd: new Date(now + 1000),
      windowMs: 2000,
      buckets: 1,
      slowMs: 100,
      truncated: false,
    });
    expect(result.families?.[0]?.familyHash).toBe('slow'); // ranked by p99 desc
  });

  it('computes cache hit/miss/set breakdown (Adonis op enum)', () => {
    seq = 0;
    const now = Date.now();
    const entries = [
      entry(EntryType.Cache, new Date(now), null, { content: { operation: 'hit', key: 'k1' } }),
      entry(EntryType.Cache, new Date(now), null, { content: { operation: 'miss', key: 'k2' } }),
      entry(EntryType.Cache, new Date(now), null, { content: { operation: 'write', key: 'k1' } }),
    ];
    const result = summarizeStats({
      entries,
      type: EntryType.Cache,
      windowStart: new Date(now - 1000),
      windowEnd: new Date(now + 1000),
      windowMs: 2000,
      buckets: 1,
      slowMs: 100,
      truncated: false,
    });
    expect(result.cache?.hits).toBe(1);
    expect(result.cache?.misses).toBe(1);
    expect(result.cache?.sets).toBe(1);
    expect(result.cache?.hitRatio).toBe(0.5);
  });
});
