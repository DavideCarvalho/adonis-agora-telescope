import { afterEach, describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { DEFAULT_MASK } from '../src/redaction/redact.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import {
  type HttpContextLike,
  MAX_ENRICHMENT_TAG_LENGTH,
  MAX_ENRICHMENT_TAGS,
  type RequestEnrichment,
  type RequestEnrichmentResult,
  recordRequest,
} from '../src/request_watcher.js';
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
    expect((entry!.content as { durationMs: number }).durationMs).toBe(999);
  });

  it('records an explicit traceId onto the entry and content', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, stubCtx('GET', '/', 200), Date.now(), { traceId: 'tr-9' });
    const entry = (await store.list())[0];
    expect(entry?.traceId).toBe('tr-9');
    expect((entry!.content as { traceId: string | null }).traceId).toBe('tr-9');
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

/**
 * Status resolution across host shapes. The regression these lock down: AdonisJS's
 * `Response` exposes ONLY `getStatus()` — its `statusCode` lives on the wrapped Node
 * `ServerResponse`, one level down — so reading `ctx.response.statusCode` yielded
 * `undefined` on every real Adonis request. Every entry recorded `status: null`, no
 * `status:<code>` tag was ever emitted, and the pulse error rate (computed from the
 * 4xx/5xx breakdown) was pinned at 0% no matter how many requests were failing.
 * The optional `statusCode?: number` type could not catch it: any object satisfies it.
 */
describe('recordRequest — response status', () => {
  async function statusOf(response: HttpContextLike['response']): Promise<number | null> {
    const store = new InMemoryTelescopeStore();
    await recordRequest(
      store,
      { request: { method: () => 'GET', url: () => '/x' }, response },
      Date.now(),
    );
    const [entry] = await store.list();
    if (entry === undefined) throw new Error('no entry recorded');
    return (entry.content as { status: number | null }).status;
  }

  it('reads getStatus() — the only accessor an AdonisJS Response exposes', async () => {
    expect(await statusOf({ getStatus: () => 503 })).toBe(503);
  });

  it('tags the entry with the status resolved via getStatus()', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(
      store,
      { request: { method: () => 'GET', url: () => '/x' }, response: { getStatus: () => 404 } },
      Date.now(),
    );
    const [entry] = await store.list();
    expect(entry?.tags).toContain('status:404');
  });

  it('still reads a Node/Express-style statusCode property', async () => {
    expect(await statusOf({ statusCode: 201 })).toBe(201);
  });

  it('prefers getStatus() over a stale statusCode when a host exposes both', async () => {
    expect(await statusOf({ getStatus: () => 302, statusCode: 200 })).toBe(302);
  });

  it('falls back to statusCode when getStatus() throws', async () => {
    expect(
      await statusOf({
        getStatus: () => {
          throw new Error('response already destroyed');
        },
        statusCode: 200,
      }),
    ).toBe(200);
  });

  it('records null — never throws — when neither accessor is usable', async () => {
    expect(await statusOf({})).toBeNull();
    expect(await statusOf({ getStatus: () => Number.NaN })).toBeNull();
  });
});

/**
 * User attribution. `ctx.auth.user` is the `@adonisjs/auth` convention: a synchronous
 * property. An auth lib whose guard is async (`await getUser()`) has nothing there at
 * record time, so entries recorded `user: null` for fully authenticated sessions —
 * the whole "User" column and every `user:<id>` tag were dead on such a stack. Those
 * hosts publish the resolved reference into `@adonis-agora/context` instead, which is
 * the fallback these lock down.
 */
describe('recordRequest — user attribution', () => {
  const KEY = Symbol.for('@agora/context:accessor');
  afterEach(() => delete (globalThis as Record<symbol, unknown>)[KEY]);

  function withUserRef(userRef: unknown): void {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      traceId: () => undefined,
      tenantId: () => undefined,
      userRef: () => userRef,
      get: () => undefined,
    };
  }

  async function userOf(ctx: HttpContextLike) {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, ctx, Date.now());
    const [entry] = await store.list();
    if (entry === undefined) throw new Error('no entry recorded');
    return {
      user: (entry.content as { user: { id: string; email?: string } | null }).user,
      tags: entry.tags,
    };
  }

  const bare: HttpContextLike = { request: { method: () => 'GET', url: () => '/x' }, response: {} };

  it('reads the synchronous ctx.auth.user (the @adonisjs/auth convention)', async () => {
    const { user, tags } = await userOf({ ...bare, auth: { user: { id: 7, email: 'a@b.c' } } });
    expect(user).toEqual({ id: '7', email: 'a@b.c' });
    expect(tags).toContain('user:7');
  });

  it('falls back to the context userRef when the guard exposes no sync user', async () => {
    withUserRef({ type: 'user', id: 'usr-42' });
    const { user, tags } = await userOf({ ...bare, auth: {} });
    expect(user).toEqual({ id: 'usr-42' });
    expect(tags).toContain('user:usr-42');
  });

  it('falls back to the context userRef when there is no auth guard at all', async () => {
    withUserRef({ id: 'usr-99', email: 'x@y.z' });
    const { user } = await userOf(bare);
    expect(user).toEqual({ id: 'usr-99', email: 'x@y.z' });
  });

  it('prefers the auth guard over the context when both are present', async () => {
    withUserRef({ id: 'from-context' });
    const { user } = await userOf({ ...bare, auth: { user: { id: 'from-guard' } } });
    expect(user).toEqual({ id: 'from-guard' });
  });

  it('records null when neither source has a usable identity', async () => {
    withUserRef(undefined);
    expect((await userOf(bare)).user).toBeNull();
    expect((await userOf({ ...bare, auth: { user: { noId: true } } })).user).toBeNull();
  });

  it('survives a throwing guard by still consulting the context', async () => {
    withUserRef({ id: 'usr-1' });
    const hostile = {
      ...bare,
      auth: {
        get user(): unknown {
          throw new Error('guard exploded');
        },
      },
    };
    expect((await userOf(hostile)).user).toEqual({ id: 'usr-1' });
  });

  it('never throws when the context accessor itself explodes', async () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      traceId: () => undefined,
      tenantId: () => undefined,
      userRef: () => {
        throw new Error('context exploded');
      },
      get: () => undefined,
    };
    expect((await userOf(bare)).user).toBeNull();
  });
});

/**
 * Host enrichment. The motivating case: correlating a front-end screen with the
 * calls it makes — the browser sends the current page in a header and the host
 * turns it into a `screen:<name>` tag, after which the dashboard's existing tag
 * filter answers "which requests came from the writing screen?".
 *
 * The hook runs on the recording path of every request, so most of what is locked
 * down here is that a bad hook cannot cost us the entry.
 */
describe('recordRequest — host enrichment', () => {
  function ctxWithHeader(header?: string): HttpContextLike {
    return {
      request: {
        method: () => 'GET',
        url: () => '/api/v1/researcher/projects',
        header: (name: string) => (name.toLowerCase() === 'x-screen' ? header : undefined),
      },
      response: { getStatus: () => 200 },
    };
  }

  async function record(ctx: HttpContextLike, enrich?: RequestEnrichment) {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, ctx, Date.now(), enrich === undefined ? {} : { enrich });
    const [entry] = await store.list();
    if (entry === undefined) throw new Error('no entry recorded');
    return {
      tags: entry.tags,
      content: entry.content as { context?: Record<string, unknown>; user: unknown },
    };
  }

  const screenTag: RequestEnrichment = (ctx) => {
    const screen = ctx.request.header?.('x-screen');
    return typeof screen === 'string' ? { tags: [`screen:${screen}`] } : undefined;
  };

  it('tags the entry with the screen the call came from', async () => {
    const { tags } = await record(ctxWithHeader('researcher/writing_page'), screenTag);
    expect(tags).toContain('screen:researcher/writing_page');
    // The derived tags are still there — enrichment appends, never replaces.
    expect(tags).toContain('method:GET');
    expect(tags).toContain('status:200');
  });

  it('records nothing extra when the hook returns undefined', async () => {
    const { tags, content } = await record(ctxWithHeader(undefined), screenTag);
    expect(tags).toEqual(['method:GET', 'status:200']);
    expect(content.context).toBeUndefined();
  });

  it('records free-form context on the entry', async () => {
    const { content } = await record(ctxWithHeader(), () => ({
      context: { screen: 'admin/dashboard', release: 'abc123' },
    }));
    expect(content.context).toEqual({ screen: 'admin/dashboard', release: 'abc123' });
  });

  it('lets the hook supply the user when the ctx cannot', async () => {
    const { tags, content } = await record(ctxWithHeader(), () => ({
      user: { id: 'usr-7', email: 'ada@example.com' },
    }));
    expect(content.user).toEqual({ id: 'usr-7', email: 'ada@example.com' });
    expect(tags).toContain('user:usr-7');
  });

  it('an explicit options.user still beats the hook', async () => {
    const store = new InMemoryTelescopeStore();
    await recordRequest(store, ctxWithHeader(), Date.now(), {
      user: { id: 'explicit' },
      enrich: () => ({ user: { id: 'from-hook' } }),
    });
    const [entry] = await store.list();
    if (entry === undefined) throw new Error('no entry recorded');
    expect((entry.content as { user: { id: string } }).user).toEqual({ id: 'explicit' });
  });

  it('a throwing hook costs nothing — the entry is recorded as usual', async () => {
    const { tags, content } = await record(ctxWithHeader(), () => {
      throw new Error('hook exploded');
    });
    expect(tags).toEqual(['method:GET', 'status:200']);
    expect(content.context).toBeUndefined();
  });

  it('ignores a hook that returns garbage', async () => {
    const nonsense = [null, 'nope', 42, []] as unknown as RequestEnrichmentResult[];
    for (const value of nonsense) {
      const { tags } = await record(ctxWithHeader(), () => value);
      expect(tags).toEqual(['method:GET', 'status:200']);
    }
  });

  it('caps the number of tags a hook can add', async () => {
    const many = Array.from({ length: MAX_ENRICHMENT_TAGS + 20 }, (_, i) => `t:${i}`);
    const { tags } = await record(ctxWithHeader(), () => ({ tags: many }));
    // Derived tags (method + status) plus exactly the cap.
    expect(tags).toHaveLength(2 + MAX_ENRICHMENT_TAGS);
  });

  it('truncates an overlong tag and drops non-strings and blanks', async () => {
    const { tags } = await record(ctxWithHeader(), () => ({
      tags: ['x'.repeat(MAX_ENRICHMENT_TAG_LENGTH + 50), '', 7, null, 'ok'] as string[],
    }));
    expect(tags).toContain('ok');
    expect(tags).toContain('x'.repeat(MAX_ENRICHMENT_TAG_LENGTH));
    expect(tags).toHaveLength(4); // method, status, o truncado, 'ok'
  });

  it('ignores a non-object context (arrays included)', async () => {
    const { content } = await record(ctxWithHeader(), () => ({
      context: ['nao', 'sou', 'objeto'] as unknown as Record<string, unknown>,
    }));
    expect(content.context).toBeUndefined();
  });
});
