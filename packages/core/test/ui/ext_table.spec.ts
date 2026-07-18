import { describe, expect, it } from 'vitest';
import { fillLinkHref, tablePagination } from '../../src/ui/ext_table.js';

describe('tablePagination — paged extension table', () => {
  it('reports page 2 of 3 with both prev and next available', () => {
    // A provider on page 2: 10-row limit, 25 total → 3 pages, mid-range.
    const p = tablePagination({ rows: new Array(10).fill({}), total: 25, page: 2, limit: 10 });
    expect(p.page).toBe(2);
    expect(p.totalPages).toBe(3);
    expect(p.hasPrev).toBe(true);
    expect(p.hasNext).toBe(true);
  });

  it('disables prev on the first page', () => {
    const p = tablePagination({ rows: new Array(10).fill({}), total: 25, page: 1, limit: 10 });
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(true);
  });

  it('disables next on the last page', () => {
    const p = tablePagination({ rows: new Array(5).fill({}), total: 25, page: 3, limit: 10 });
    expect(p.page).toBe(3);
    expect(p.totalPages).toBe(3);
    expect(p.hasNext).toBe(false);
    expect(p.hasPrev).toBe(true);
  });

  it('clamps a page below 1 and defaults a single page for a bare-rows payload', () => {
    const p = tablePagination({ rows: [{}, {}], page: 0 });
    expect(p.page).toBe(1);
    expect(p.totalPages).toBe(1);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });
});

describe('fillLinkHref — trace deep-link convention', () => {
  it('fills the in-app #/traces/{traceId} hash route from the row', () => {
    expect(fillLinkHref('#/traces/{traceId}', { traceId: 'abc123', other: 'x' })).toBe(
      '#/traces/abc123',
    );
  });

  it('fills a host-console template with multiple placeholders', () => {
    expect(fillLinkHref('/durable/runs/{runId}', { runId: 'run_9' })).toBe('/durable/runs/run_9');
  });

  it('URI-encodes a value so it cannot break out of the href', () => {
    expect(fillLinkHref('#/traces/{traceId}', { traceId: 'a/b?c#d' })).toBe(
      '#/traces/a%2Fb%3Fc%23d',
    );
  });

  it('renders a missing key as empty', () => {
    expect(fillLinkHref('#/traces/{traceId}', {})).toBe('#/traces/');
  });
});
