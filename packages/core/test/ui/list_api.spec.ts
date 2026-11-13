import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { TelescopeService } from '../../src/service.js';
import type { EntryQuery } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { TelescopeApi } from '../../src/ui/api.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';
import { parseEntryListRequest, readEntryPage } from '../../src/ui/list_api.js';

function ctx(qs: Record<string, unknown> = {}): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', qs), response: res }, res };
}

interface CursorBody<T> {
  data: T[];
  meta: {
    nextCursor: string | null;
    prevCursor: string | null;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('entry feed cursor', () => {
  it('walks every entry exactly once when many share the same instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'));
    const store = new InMemoryTelescopeStore();
    for (let i = 0; i < 25; i++) await store.record({ type: 'log', content: { i } });
    vi.setSystemTime(new Date('2026-11-13T12:00:01.000Z'));
    for (let i = 25; i < 40; i++) await store.record({ type: 'log', content: { i } });
    const api = new TelescopeApi(new TelescopeService(store));

    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const { ctx: c, res } = ctx({ first: '3', ...(after !== null ? { after } : {}) });
      await api.list(c);
      const body = res.body as CursorBody<{ id: string }>;
      seen.push(...body.data.map((e) => e.id));
      expect(body.meta.hasPrev).toBe(false);
      expect(body.meta.prevCursor).toBeNull();
      if (!body.meta.hasNext) break;
      after = body.meta.nextCursor;
    }
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    const all = await store.list();
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it('stays complete over a store that orders same-instant rows differently', async () => {
    const at = new Date('2026-11-13T12:00:00.000Z');
    const rows: Entry[] = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${String(i).padStart(2, '0')}`,
      type: 'log',
      familyHash: null,
      content: null,
      tags: [],
      sequence: i,
      durationMs: null,
      origin: 'manual',
      traceId: null,
      createdAt: i < 10 ? new Date(at.getTime() - 1) : at,
    }));
    // Newest instant first, but ties in ASCENDING sequence — the opposite of the feed's order.
    const list = async (q: EntryQuery) =>
      rows
        .filter((e) => q.before === undefined || e.createdAt < q.before)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.sequence - b.sequence)
        .slice(0, q.size);

    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const request = await parseEntryListRequest({
        first: '4',
        ...(after !== null ? { after } : {}),
      });
      const page = await readEntryPage(list, request);
      seen.push(...page.rows.map((e) => e.id));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(30);
    expect(seen).toHaveLength(30);
  });
});

describe('GET /api/metrics/traces', () => {
  async function seeded(count: number) {
    vi.useFakeTimers();
    const store = new InMemoryTelescopeStore();
    for (let i = 0; i < count; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 12, 0, i)));
      await store.record({ type: 'request', content: { i }, traceId: `trace-${i}` });
    }
    vi.useRealTimers();
    return new TelescopeApi(new TelescopeService(store));
  }

  it('pages forward and backward with opaque cursors', async () => {
    const api = await seeded(5);

    const p1 = ctx({ first: '2' });
    await api.metricsTraces(p1.ctx);
    const page1 = p1.res.body as CursorBody<{ traceId: string }>;
    expect(page1.data.map((t) => t.traceId)).toEqual(['trace-4', 'trace-3']);
    expect(page1.meta).toMatchObject({ hasNext: true, hasPrev: false, prevCursor: null });

    const p2 = ctx({ first: '2', after: page1.meta.nextCursor });
    await api.metricsTraces(p2.ctx);
    const page2 = p2.res.body as CursorBody<{ traceId: string }>;
    expect(page2.data.map((t) => t.traceId)).toEqual(['trace-2', 'trace-1']);
    expect(page2.meta).toMatchObject({ hasNext: true, hasPrev: true });

    const p3 = ctx({ first: '2', after: page2.meta.nextCursor });
    await api.metricsTraces(p3.ctx);
    const page3 = p3.res.body as CursorBody<{ traceId: string }>;
    expect(page3.data.map((t) => t.traceId)).toEqual(['trace-0']);
    expect(page3.meta).toMatchObject({ hasNext: false, nextCursor: null, hasPrev: true });

    const back = ctx({ last: '2', before: page3.meta.prevCursor });
    await api.metricsTraces(back.ctx);
    const backPage = back.res.body as CursorBody<{ traceId: string }>;
    expect(backPage.data.map((t) => t.traceId)).toEqual(['trace-2', 'trace-1']);
    expect(backPage.meta).toMatchObject({ hasNext: true, hasPrev: true });
  });

  it('keeps its place when the page size changes mid-walk', async () => {
    const api = await seeded(5);
    const p1 = ctx({ first: '2' });
    await api.metricsTraces(p1.ctx);
    const page1 = p1.res.body as CursorBody<{ traceId: string }>;
    const p2 = ctx({ first: '3', after: page1.meta.nextCursor });
    await api.metricsTraces(p2.ctx);
    const page2 = p2.res.body as CursorBody<{ traceId: string }>;
    expect(page2.data.map((t) => t.traceId)).toEqual(['trace-2', 'trace-1', 'trace-0']);
    expect(page2.meta.hasNext).toBe(false);
  });

  it.each([
    [{ filter: { traceId: 'x' } }, 'Unknown filter field'],
    [{ sort: 'traceId' }, 'Unknown sort field'],
    [{ after: 'nope' }, 'Invalid cursor'],
  ])('answers 400 for %j', async (qs, message) => {
    const api = await seeded(1);
    const { ctx: c, res } = ctx(qs);
    await api.metricsTraces(c);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain(message);
  });
});
