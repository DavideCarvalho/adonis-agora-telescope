import { describe, expect, it } from 'vitest';
import { csvCell, entriesToCsv, toPrettyJson } from './export.js';
import type { EntrySummary } from './types.js';

const entry: EntrySummary = {
  id: 'e1',
  type: 'request',
  familyHash: 'GET /users',
  tags: ['status:200', 'method:GET'],
  traceId: 'trace-1',
  durationMs: 12.5,
  sequence: 1,
  createdAt: '2026-08-12T10:00:00.000Z',
  summary: 'GET /users → 200',
};

describe('toPrettyJson', () => {
  it('pretty-prints the entries as a JSON array', () => {
    const json = toPrettyJson([entry]);
    expect(JSON.parse(json)).toEqual([entry]);
    expect(json).toContain('\n');
  });
});

describe('csvCell', () => {
  it('leaves a plain value untouched', () => {
    expect(csvCell('hello')).toBe('hello');
  });

  it('quotes and escapes a value containing a comma, quote, or newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('entriesToCsv', () => {
  it('renders a header row plus one row per entry, joined by CRLF', () => {
    const csv = entriesToCsv([entry]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('id,type,createdAt,durationMs,tags,familyHash,traceId,summary');
    expect(row ?? '').toContain('e1,request,2026-08-12T10:00:00.000Z,12.5');
    expect(row ?? '').toContain('status:200; method:GET');
    expect((row ?? '').endsWith('GET /users → 200')).toBe(true);
  });

  it('renders an empty durationMs as an empty field', () => {
    const csv = entriesToCsv([{ ...entry, durationMs: null }]);
    const [, row] = csv.split('\r\n');
    expect(row ?? '').toContain('e1,request,2026-08-12T10:00:00.000Z,,');
  });
});
