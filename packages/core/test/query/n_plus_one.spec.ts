import { describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../../src/entry.js';
import { detectNPlusOne, detectNPlusOnePatterns } from '../../src/query/n_plus_one.js';

let seq = 0;
function query(over: Partial<Entry>): Entry {
  return {
    id: `id-${seq}`,
    type: EntryType.Query,
    familyHash: null,
    content: { sql: 'x' },
    tags: [],
    sequence: seq++,
    durationMs: 1,
    origin: 'http',
    traceId: 't',
    createdAt: new Date(seq * 1000),
    ...over,
  };
}

describe('detectNPlusOne (flat family-count)', () => {
  it('reports templates that run >= threshold times', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'a', content: { sql: 'select * from a' } }),
      query({ familyHash: 'b', content: { sql: 'select * from b where id = ?' } }),
      query({ familyHash: 'b', content: { sql: 'select * from b where id = ?' } }),
      query({ familyHash: 'b', content: { sql: 'select * from b where id = ?' } }),
    ];
    const insights = detectNPlusOne(entries, 3);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.familyHash).toBe('b');
    expect(insights[0]?.count).toBe(3);
    expect(insights[0]?.sql).toContain('b');
  });

  it('ignores non-query entries and null family hashes', () => {
    seq = 0;
    const entries = [
      query({ type: EntryType.Request, familyHash: 'r' }),
      query({ familyHash: null }),
      query({ familyHash: 'q', content: { sql: 'q' } }),
      query({ familyHash: 'q', content: { sql: 'q' } }),
    ];
    expect(detectNPlusOne(entries, 2)).toHaveLength(1);
  });
});

describe('detectNPlusOnePatterns (loop attribution + ranking)', () => {
  it('detects the classic 1 parent + N similar children loop', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'authors', content: { sql: 'select * from author' }, durationMs: 5 }),
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 3,
      }),
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 3,
      }),
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 4,
      }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns).toHaveLength(1);
    const p = patterns[0];
    expect(p?.childFamilyHash).toBe('book');
    expect(p?.count).toBe(3);
    expect(p?.parentFamilyHash).toBe('authors');
    expect(p?.parentSql).toContain('author');
    expect(p?.childSql).toContain('book');
  });

  it('weights by total child duration', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'p', content: { sql: 'select * from p' }, durationMs: 1 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 10 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 20 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 30 }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns[0]?.totalDurationMs).toBe(60);
  });

  it('ranks patterns by total wasted duration, not just count', () => {
    seq = 0;
    const entries = [
      ...Array.from({ length: 5 }, () =>
        query({ familyHash: 'fast', content: { sql: 'select 1 where id = ?' }, durationMs: 1 }),
      ),
      ...Array.from({ length: 3 }, () =>
        query({ familyHash: 'slow', content: { sql: 'select 2 where id = ?' }, durationMs: 50 }),
      ),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns.map((p) => p.childFamilyHash)).toEqual(['slow', 'fast']);
  });

  it('does not flag below the threshold', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'p', content: { sql: 'select * from p' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
    ];
    expect(detectNPlusOnePatterns(entries, { threshold: 3 })).toEqual([]);
  });

  it('reports no parent when the loop is the very first thing in the trace', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.parentFamilyHash).toBeNull();
    expect(patterns[0]?.parentSql).toBeNull();
  });

  it('carries the trace id of the pattern', () => {
    seq = 0;
    const entries = [
      query({ familyHash: 'c', traceId: 'trace-9', content: { sql: 'c where id = ?' } }),
      query({ familyHash: 'c', traceId: 'trace-9', content: { sql: 'c where id = ?' } }),
      query({ familyHash: 'c', traceId: 'trace-9', content: { sql: 'c where id = ?' } }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns[0]?.traceId).toBe('trace-9');
  });
});
