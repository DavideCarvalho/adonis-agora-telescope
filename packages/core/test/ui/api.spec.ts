import { beforeEach, describe, expect, it } from 'vitest';
import type { RecordInput } from '../../src/entry.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { TelescopeApi } from '../../src/ui/api.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';

function ctx(qs: Record<string, unknown> = {}): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET', qs), response: res }, res };
}

async function seed(store: InMemoryTelescopeStore) {
  const inputs: RecordInput[] = [
    {
      type: 'request',
      content: { method: 'GET', url: '/users', status: 200 },
      tags: ['method:GET', 'status:200'],
      familyHash: 'GET /users',
      traceId: 'trace-a',
      durationMs: 12,
      origin: 'http',
    },
    {
      type: 'request',
      content: { method: 'POST', url: '/login', status: 500 },
      tags: ['method:POST', 'status:500'],
      familyHash: 'POST /login',
      traceId: 'trace-b',
      durationMs: 40,
      origin: 'http',
    },
    {
      type: 'diagnostic',
      content: { lib: 'billing', event: 'invoice-paid' },
      tags: ['lib:billing', 'event:invoice-paid'],
      familyHash: 'billing:invoice-paid',
      traceId: 'trace-a',
      origin: 'manual',
    },
  ];
  const recorded = [];
  for (const input of inputs) recorded.push(await store.record(input));
  return recorded;
}

describe('TelescopeApi', () => {
  let store: InMemoryTelescopeStore;
  let api: TelescopeApi;

  beforeEach(async () => {
    store = new InMemoryTelescopeStore();
    api = new TelescopeApi(new TelescopeService(store));
    await seed(store);
  });

  it('lists entries newest-first as summaries', async () => {
    const { ctx: c, res } = ctx();
    await api.list(c);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      data: Array<{ type: string; summary: string }>;
      meta: { count: number };
    };
    expect(body.meta.count).toBe(3);
    // newest first: diagnostic was recorded last
    expect(body.data[0]?.type).toBe('diagnostic');
    expect(body.data[0]?.summary).toBe('billing:invoice-paid');
    // request summary derives method + url + status
    const req = body.data.find((e) => e.type === 'request');
    expect(req?.summary).toContain('/');
    // summaries omit the full content payload
    expect((body.data[0] as Record<string, unknown>).content).toBeUndefined();
  });

  it('filters by type', async () => {
    const { ctx: c, res } = ctx({ type: 'request' });
    await api.list(c);
    const body = res.body as { data: Array<{ type: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data.every((e) => e.type === 'request')).toBe(true);
  });

  it('filters by traceId', async () => {
    const { ctx: c, res } = ctx({ traceId: 'trace-a' });
    await api.list(c);
    const body = res.body as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it('filters by search across content + tags', async () => {
    const { ctx: c, res } = ctx({ search: 'invoice' });
    await api.list(c);
    const body = res.body as { data: Array<{ type: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.type).toBe('diagnostic');
  });

  it('caps limit to the configured max', async () => {
    const { ctx: c, res } = ctx({ limit: '99999' });
    await api.list(c);
    const body = res.body as { meta: { query: { limit: number } } };
    expect(body.meta.query.limit).toBe(500);
  });

  it('returns one entry with full content for show()', async () => {
    const all = await store.list();
    const id = all[0]?.id as string;
    const { ctx: c, res } = ctx();
    await api.show(c, id);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: { id: string; content: unknown } };
    expect(body.data.id).toBe(id);
    expect(body.data.content).toBeDefined();
  });

  it('404s an unknown entry id', async () => {
    const { ctx: c, res } = ctx();
    await api.show(c, 'does-not-exist');
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/not found/i);
  });

  it('returns every entry under a trace', async () => {
    const { ctx: c, res } = ctx();
    await api.trace(c, 'trace-a');
    const body = res.body as { data: unknown[]; meta: { traceId: string; count: number } };
    expect(body.meta.traceId).toBe('trace-a');
    expect(body.meta.count).toBe(2);
  });

  it('returns stats with count, topFamilies and topTags', async () => {
    const { ctx: c, res } = ctx();
    await api.stats(c);
    const body = res.body as {
      data: { count: number; topFamilies: Array<{ key: string }>; topTags: Array<{ key: string }> };
    };
    expect(body.data.count).toBe(3);
    expect(body.data.topFamilies.length).toBeGreaterThan(0);
    const tagKeys = body.data.topTags.map((t) => t.key);
    expect(tagKeys).toContain('lib:billing');
  });

  it('scopes topFamilies by type in stats', async () => {
    const { ctx: c, res } = ctx({ type: 'diagnostic' });
    await api.stats(c);
    const body = res.body as { data: { topFamilies: Array<{ key: string }> } };
    expect(body.data.topFamilies.map((f) => f.key)).toEqual(['billing:invoice-paid']);
  });
});

describe('toSummary user label', () => {
  it('derives userLabel from a request entry content.user (email wins)', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {
        method: 'GET',
        url: '/me',
        status: 200,
        durationMs: 5,
        traceId: 'trace-u',
        user: { id: '42', email: 'ada@example.com' },
      },
      tags: ['method:GET'],
      traceId: 'trace-u',
      durationMs: 5,
      origin: 'http',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = res.body as { data: { userLabel?: string }[] };
    expect(body.data[0]?.userLabel).toBe('ada@example.com');
  });

  it('omits userLabel when content has no user', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'diagnostic',
      content: { lib: 'billing', event: 'invoice-paid' },
      tags: ['lib:billing'],
      origin: 'manual',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = res.body as { data: Record<string, unknown>[] };
    expect('userLabel' in (body.data[0] ?? {})).toBe(false);
  });

  it('omits userLabel when a request entry carries a null user', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {
        method: 'GET',
        url: '/public',
        status: 200,
        durationMs: 5,
        traceId: 'trace-anon',
        user: null,
      },
      tags: ['method:GET'],
      traceId: 'trace-anon',
      durationMs: 5,
      origin: 'http',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = res.body as { data: Record<string, unknown>[] };
    expect('userLabel' in (body.data[0] ?? {})).toBe(false);
  });

  it('falls back to the user id when email is missing', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {
        method: 'GET',
        url: '/me',
        status: 200,
        durationMs: 5,
        traceId: 'trace-u1',
        user: { id: 'u-1' },
      },
      tags: ['method:GET'],
      traceId: 'trace-u1',
      durationMs: 5,
      origin: 'http',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = res.body as { data: { userLabel?: string }[] };
    expect(body.data[0]?.userLabel).toBe('u-1');
  });

  it('falls back to the user id when email is empty', async () => {
    const store = new InMemoryTelescopeStore();
    await store.record({
      type: 'request',
      content: {
        method: 'GET',
        url: '/me',
        status: 200,
        durationMs: 5,
        traceId: 'trace-u2',
        user: { id: 'u-1', email: '' },
      },
      tags: ['method:GET'],
      traceId: 'trace-u2',
      durationMs: 5,
      origin: 'http',
    });
    const api = new TelescopeApi(new TelescopeService(store));
    const { ctx: c, res } = ctx();
    await api.list(c);
    const body = res.body as { data: { userLabel?: string }[] };
    expect(body.data[0]?.userLabel).toBe('u-1');
  });
});
