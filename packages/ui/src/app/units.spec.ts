import { describe, expect, it } from 'vitest';
import type { Waterfall } from '../client/types.js';
import { flattenWaterfall } from './TraceDetail.js';
import { parseEntryFrame } from './use-telescope.js';

describe('parseEntryFrame', () => {
  it('parses a valid entry summary frame', () => {
    const frame = JSON.stringify({ id: 'e1', type: 'request', summary: 'GET / → 200', tags: [] });
    const parsed = parseEntryFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('e1');
    expect(parsed?.type).toBe('request');
  });
  it('rejects non-JSON, non-objects, and payloads missing id/type', () => {
    expect(parseEntryFrame('not json')).toBeNull();
    expect(parseEntryFrame('42')).toBeNull();
    expect(parseEntryFrame('null')).toBeNull();
    expect(parseEntryFrame(JSON.stringify({ type: 'request' }))).toBeNull();
    expect(parseEntryFrame(JSON.stringify({ id: 'e1' }))).toBeNull();
  });
});

describe('flattenWaterfall', () => {
  const waterfall: Waterfall = {
    traceStartMs: 0,
    totalDurationMs: 100,
    spans: [
      {
        id: 'root',
        type: 'request',
        label: 'GET /users',
        offsetMs: 0,
        durationMs: 100,
        depth: 0,
        sequence: 0,
        children: [
          {
            id: 'child',
            type: 'query',
            label: 'select * from users',
            offsetMs: 20,
            durationMs: 40,
            depth: 1,
            sequence: 1,
            children: [],
          },
        ],
      },
    ],
  };

  it('flattens depth-first with computed geometry', () => {
    const rows = flattenWaterfall(waterfall);
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'child']);
    expect(rows[0]?.leftPct).toBe(0);
    expect(rows[0]?.widthPct).toBe(100);
    expect(rows[1]?.leftPct).toBe(20);
    expect(rows[1]?.widthPct).toBe(40);
  });

  it('clamps a zero-total trace to a visible minimum width', () => {
    const rows = flattenWaterfall({
      traceStartMs: 0,
      totalDurationMs: 0,
      spans: [
        {
          id: 'x',
          type: 'log',
          label: 'x',
          offsetMs: 0,
          durationMs: 0,
          depth: 0,
          sequence: 0,
          children: [],
        },
      ],
    });
    expect(rows[0]?.widthPct).toBeGreaterThan(0);
  });
});
