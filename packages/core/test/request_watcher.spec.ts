import { describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { DEFAULT_MASK } from '../src/redaction/redact.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import { type HttpContextLike, recordRequest } from '../src/request_watcher.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

function stubCtx(method: string, url: string, statusCode?: number): HttpContextLike {
  return {
    request: { method: () => method, url: () => url },
    response: statusCode !== undefined ? { statusCode } : {},
  };
}

/** A ctx whose request exposes a parsed body + headers (for requestCapture tests). */
function bodyCtx(options: {
  method?: string;
  url?: string;
  body: unknown;
  headers?: Record<string, string>;
}): HttpContextLike {
  const headers = options.headers ?? {};
  return {
    request: {
      method: () => options.method ?? 'POST',
      url: () => options.url ?? '/submit',
      body: () => options.body,
      header: (name: string) => headers[name.toLowerCase()],
    },
    response: { statusCode: 200 },
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

describe('recordRequest — requestCapture body gates', () => {
  async function record(ctx: HttpContextLike, capture: object): Promise<unknown> {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, ctx, Date.now(), { capture });
    return (await store.list())[0]?.content as { body?: unknown };
  }

  it('does NOT add a body field when requestCapture is not configured (default off)', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, bodyCtx({ body: { a: 1 } }), Date.now());
    const content = (await store.list())[0]?.content as Record<string, unknown>;
    expect('body' in content).toBe(false);
  });

  it('captures a body that passes every gate', async () => {
    const content = (await record(
      bodyCtx({ body: { email: 'a@b.c' }, headers: { 'content-type': 'application/json' } }),
      {},
    )) as { body: unknown };
    expect(content.body).toEqual({ email: 'a@b.c' });
  });

  it('skips a body over the size gate (content-length header)', async () => {
    const content = (await record(
      bodyCtx({
        body: { big: 'payload' },
        headers: { 'content-type': 'application/json', 'content-length': '200000' },
      }),
      { maxBodyBytes: 131_072 },
    )) as { body: string };
    expect(content.body).toBe('[Skipped: 200000 bytes > 131072 bytes]');
  });

  it('skips a body over the size gate by its own string length (no content-length)', async () => {
    const content = (await record(bodyCtx({ body: 'x'.repeat(500) }), { maxBodyBytes: 100 })) as {
      body: string;
    };
    expect(content.body).toBe('[Skipped: 500 bytes > 100 bytes]');
  });

  it('skips a body whose content-type matches a skip pattern (binary/multipart)', async () => {
    const content = (await record(
      bodyCtx({
        body: 'RAW-BYTES',
        headers: { 'content-type': 'multipart/form-data; boundary=abc' },
      }),
      {},
    )) as { body: string };
    expect(content.body).toBe('[Skipped: multipart/form-data; boundary=abc]');
  });

  it('skips a body when the skipBody predicate returns true', async () => {
    const content = (await record(bodyCtx({ url: '/internal/ping', body: { a: 1 } }), {
      skipBody: (req: { url: string }) => req.url === '/internal/ping',
    })) as { body: string };
    expect(content.body).toBe('[Skipped: skipBody predicate]');
  });

  it('captures within-gate bodies and STILL redacts sensitive keys downstream', async () => {
    const inner = new InMemoryTelescopeStore();
    const store = new RedactingTelescopeStore(inner);
    await recordRequest(
      store,
      bodyCtx({
        body: { password: 'hunter2', email: 'a@b.c' },
        headers: { 'content-type': 'application/json' },
      }),
      Date.now(),
      { capture: {} },
    );
    const content = (await inner.list())[0]?.content as { body: Record<string, string> };
    expect(content.body.password).toBe(DEFAULT_MASK);
    expect(content.body.email).toBe('a@b.c');
  });
});
