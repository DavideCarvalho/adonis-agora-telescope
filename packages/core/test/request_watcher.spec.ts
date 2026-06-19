import { describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';
import { type HttpContextLike, recordRequest } from '../src/request_watcher.js';

function stubCtx(method: string, url: string, statusCode?: number): HttpContextLike {
  return {
    request: { method: () => method, url: () => url },
    response: statusCode !== undefined ? { statusCode } : {},
  };
}

describe('recordRequest', () => {
  it('records a request entry with method, url, status, duration', async () => {
    const store = new InMemoryTelescopeStore();
    const startedAt = Date.now() - 25;
    await recordRequest(store, stubCtx('get', '/users/42', 200), startedAt);

    const entries = await store.list({ type: EntryType.Request });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    const content = entry?.content as {
      method: string;
      url: string;
      status: number | null;
      durationMs: number;
    };
    expect(content.method).toBe('GET');
    expect(content.url).toBe('/users/42');
    expect(content.status).toBe(200);
    expect(content.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry?.tags).toContain('method:GET');
    expect(entry?.tags).toContain('status:200');
    expect(entry?.origin).toBe('http');
  });

  it('strips the query string from the url', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx('GET', '/search?q=hello&p=2', 200), Date.now());
    const content = (await store.list())[0]?.content as { url: string };
    expect(content.url).toBe('/search');
  });

  it('handles a missing status code as null (no status tag)', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx('POST', '/webhook'), Date.now());
    const entry = (await store.list())[0];
    const content = entry?.content as { status: number | null };
    expect(content.status).toBeNull();
    expect(entry?.tags.some((t) => t.startsWith('status:'))).toBe(false);
  });

  it('uses an explicit duration override', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx('GET', '/', 204), Date.now(), { durationMs: 999 });
    const entry = (await store.list())[0];
    expect(entry?.durationMs).toBe(999);
    expect((entry?.content as { durationMs: number }).durationMs).toBe(999);
  });

  it('records an explicit traceId onto the entry and content', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx('GET', '/', 200), Date.now(), { traceId: 'tr-9' });
    const entry = (await store.list())[0];
    expect(entry?.traceId).toBe('tr-9');
    expect((entry?.content as { traceId: string | null }).traceId).toBe('tr-9');
  });
});
