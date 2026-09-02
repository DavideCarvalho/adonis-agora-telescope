import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveClientErrors } from '../../src/client_errors/config.js';
import {
  type ClientErrorHttpContext,
  ClientErrorIngestor,
  storeRecorder,
} from '../../src/client_errors/ingestor.js';
import type { ClientExceptionContent } from '../../src/client_errors/validation.js';
import { EntryType, type RecordInput } from '../../src/entry.js';
import { redactBounded } from '../../src/redaction/redact.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

/** A recording HTTP context double: captures status + body, feeds a fixed body/ip/headers. */
function fakeCtx(options: {
  body?: unknown;
  ip?: string | undefined;
  headers?: Record<string, string>;
}): ClientErrorHttpContext & { statusCode: number; sent: unknown } {
  const headers = options.headers ?? {};
  const ctx = {
    statusCode: 200,
    sent: undefined as unknown,
    request: {
      body: () => options.body,
      header: (name: string) => headers[name.toLowerCase()],
      ip: () => options.ip,
    },
    response: {
      status(code: number) {
        ctx.statusCode = code;
        return ctx.response;
      },
      send(body: unknown) {
        ctx.sent = body;
        return body;
      },
    },
  };
  return ctx;
}

function ingestor(
  overrides: Parameters<typeof resolveClientErrors>[0] = {},
  deps: {
    record?: (input: RecordInput<ClientExceptionContent>) => void;
    isPaused?: () => boolean;
    now?: () => number;
  } = {},
): { ing: ClientErrorIngestor; recorded: RecordInput<ClientExceptionContent>[] } {
  const recorded: RecordInput<ClientExceptionContent>[] = [];
  const ing = new ClientErrorIngestor({
    config: resolveClientErrors({ enabled: true, ...overrides }),
    record: deps.record ?? ((input) => recorded.push(input)),
    isPaused: deps.isPaused ?? (() => false),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return { ing, recorded };
}

describe('ClientErrorIngestor', () => {
  it('records a valid report as a client_exception and answers 204', async () => {
    const { ing, recorded } = ingestor();
    const ctx = fakeCtx({
      body: {
        message: 'boom',
        name: 'TypeError',
        stack: 'TypeError: boom\n  at f (a.js:1:1)',
        user: { id: 9 },
      },
      ip: '203.0.113.4',
    });

    await ing.handle(ctx);

    expect(ctx.statusCode).toBe(204);
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe(EntryType.ClientException);
    expect(entry.tags).toEqual(['failed', 'client', 'user:9']);
    expect(entry.familyHash).toBe('TypeError:boom:at f (a.js:1:1)');
    expect(entry.content.message).toBe('boom');
    expect(entry.content.clientIp).toBe('203.0.113.4');
  });

  it('records clientIp as null when the IP is unknown', async () => {
    const { ing, recorded } = ingestor();
    await ing.handle(fakeCtx({ body: { message: 'm' }, ip: undefined }));
    expect(recorded[0]!.content.clientIp).toBeNull();
  });

  it('orders content so clientIp/url/userAgent lead and stack/componentStack come last', async () => {
    const { ing, recorded } = ingestor();
    await ing.handle(
      fakeCtx({
        body: {
          message: 'boom',
          name: 'TypeError',
          url: 'https://dev.example/dashboard',
          userAgent: 'Mozilla/5.0',
          stack: 'TypeError: boom\n  at f (a.js:1:1)',
          componentStack: 'at Component',
        },
        ip: '203.0.113.4',
      }),
    );
    const keys = Object.keys(recorded[0]!.content);
    // clientIp/url/userAgent MUST precede stack/componentStack: the redaction
    // byte budget drops keys in insertion order, so a huge componentStack must
    // never be positioned ahead of the short enrichment fields the alert renders.
    expect(keys.indexOf('clientIp')).toBeLessThan(keys.indexOf('stack'));
    expect(keys.indexOf('url')).toBeLessThan(keys.indexOf('componentStack'));
    expect(keys.indexOf('userAgent')).toBeLessThan(keys.indexOf('componentStack'));
    expect(keys.indexOf('stack')).toBeLessThan(keys.indexOf('componentStack'));
  });

  it('keeps clientIp/url/userAgent when a huge componentStack would exhaust the redaction budget', async () => {
    // A deeply-nested React error boundary produces a componentStack of many KB.
    // The short enrichment fields the Slack alert renders (clientIp/url/userAgent)
    // must NOT be starved out of the content by that big string — they are ordered
    // ahead of the stacks so the byte budget covers them first. This runs the
    // recorded content through the same bounded redaction the store applies.
    const { ing, recorded } = ingestor();
    const componentStack = 'at Component\n'.repeat(600); // ~7.8 KB, well over budget
    await ing.handle(
      fakeCtx({
        body: {
          message: 'f.map is not a function',
          name: 'TypeError',
          url: 'https://dev.example/dashboard/vehicle-statistics',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
          componentStack,
        },
        ip: '203.0.113.7',
      }),
    );

    const redacted = redactBounded(recorded[0]!.content, { maxContentBytes: 2_000 })
      .value as Record<string, unknown>;
    expect(redacted.clientIp).toBe('203.0.113.7');
    expect(redacted.url).toBe('https://dev.example/dashboard/vehicle-statistics');
    expect(redacted.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0)');
  });

  it('rejects an oversized body with 413 before validating', async () => {
    const { ing, recorded } = ingestor({ maxBodyBytes: 100 });
    const ctx = fakeCtx({ body: { message: 'x'.repeat(500) }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(413);
    expect(recorded).toHaveLength(0);
  });

  it('rejects an invalid body with 400', async () => {
    const { ing, recorded } = ingestor();
    const ctx = fakeCtx({ body: { notMessage: true }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(400);
    expect(recorded).toHaveLength(0);
  });

  it('enforces the per-IP rate limit with 429', async () => {
    const { ing, recorded } = ingestor({ rateLimit: { perMinute: 2 } }, { now: () => 0 });
    const mk = () => fakeCtx({ body: { message: 'm' }, ip: '9.9.9.9' });
    await ing.handle(mk());
    await ing.handle(mk());
    const third = mk();
    await ing.handle(third);
    expect(third.statusCode).toBe(429);
    expect(recorded).toHaveLength(2);
  });

  it('sheds (drops the entry) while the overload guard has paused, still answering 204', async () => {
    const { ing, recorded } = ingestor({}, { isPaused: () => true });
    const ctx = fakeCtx({ body: { message: 'm' }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(204);
    expect(recorded).toHaveLength(0);
  });

  it('rejects with 403 when the authorize hook denies', async () => {
    const { ing, recorded } = ingestor({ authorize: () => false });
    const ctx = fakeCtx({ body: { message: 'm' }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it('treats an authorize-hook throw as a denial (fail closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ing, recorded } = ingestor({
      authorize: () => {
        throw new Error('hook boom');
      },
    });
    const ctx = fakeCtx({ body: { message: 'm' }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(403);
    expect(recorded).toHaveLength(0);
    warn.mockRestore();
  });

  it('allows the request when the authorize hook approves', async () => {
    const { ing, recorded } = ingestor({ authorize: async () => true });
    const ctx = fakeCtx({ body: { message: 'm' }, ip: '1.1.1.1' });
    await ing.handle(ctx);
    expect(ctx.statusCode).toBe(204);
    expect(recorded).toHaveLength(1);
  });

  it('storeRecorder persists through a real store and swallows failures', async () => {
    const store = new InMemoryTelescopeStore();
    const { ing } = ingestor({}, { record: storeRecorder(store) });
    await ing.handle(fakeCtx({ body: { message: 'persisted' }, ip: '1.1.1.1' }));
    // storeRecorder is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    const entries = await store.list({ type: EntryType.ClientException });
    expect(entries).toHaveLength(1);
    expect((entries[0]!.content as ClientExceptionContent).message).toBe('persisted');
  });
});

describe('resolveClientErrors', () => {
  it('applies defaults (disabled, standard path/caps)', () => {
    const c = resolveClientErrors();
    expect(c.enabled).toBe(false);
    expect(c.path).toBe('/telescope/client-errors');
    expect(c.maxBodyBytes).toBe(32_768);
    expect(c.rateLimitPerMinute).toBe(60);
    expect(c.authorize).toBeUndefined();
  });

  it('respects overrides', () => {
    const authorize = () => true;
    const c = resolveClientErrors({
      enabled: true,
      path: '/errs',
      maxBodyBytes: 1024,
      rateLimit: { perMinute: 5 },
      authorize,
    });
    expect(c).toMatchObject({
      enabled: true,
      path: '/errs',
      maxBodyBytes: 1024,
      rateLimitPerMinute: 5,
      authorize,
    });
  });
});

/**
 * Who a browser-reported error belongs to.
 *
 * The ingestion endpoint is PUBLIC, so anything in the body is a claim: a caller
 * can post someone else's id. But the endpoint sits behind the host's normal
 * middleware stack, so `@adonis-agora/context` has already resolved the session's
 * user by the time we record — server-side, and therefore authoritative.
 *
 * Before this, `user` came from the body alone. No front-end reporter ships the
 * logged-in user by default, so in practice every `client_exception` recorded
 * `user: null` and the dashboard's User column was empty on a fully authenticated
 * session.
 */
describe('ClientErrorIngestor — user attribution', () => {
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

  async function ingest(body: Record<string, unknown>) {
    const { ing, recorded } = ingestor();
    await ing.handle(fakeCtx({ body }));
    const [entry] = recorded;
    if (entry === undefined) throw new Error('nothing recorded');
    return { user: entry.content.user, tags: entry.tags ?? [] };
  }

  it('attributes to the session user resolved server-side', async () => {
    withUserRef({ type: 'user', id: 'usr-7' });
    const { user, tags } = await ingest({ message: 'boom' });
    expect(user).toEqual({ type: 'user', id: 'usr-7' });
    expect(tags).toContain('user:usr-7');
  });

  it('the server-side context WINS over whatever the browser claims', async () => {
    // The endpoint is public: a claimed id must never override the real session.
    withUserRef({ id: 'real-session-user' });
    const { user, tags } = await ingest({ message: 'boom', user: { id: 'impostor' } });
    expect(user).toEqual({ id: 'real-session-user' });
    expect(tags).toContain('user:real-session-user');
    expect(tags).not.toContain('user:impostor');
  });

  it('falls back to the body claim when there is no session to contradict it', async () => {
    const { user, tags } = await ingest({ message: 'boom', user: { id: 'self-reported' } });
    expect(user).toEqual({ id: 'self-reported' });
    expect(tags).toContain('user:self-reported');
  });

  it('records null — and no user tag — when neither source has anything', async () => {
    const { user, tags } = await ingest({ message: 'boom' });
    expect(user).toBeNull();
    expect(tags.some((tag) => tag.startsWith('user:'))).toBe(false);
  });

  it('never lets a throwing context accessor break ingestion', async () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      traceId: () => undefined,
      tenantId: () => undefined,
      userRef: () => {
        throw new Error('context exploded');
      },
      get: () => undefined,
    };
    const { user } = await ingest({ message: 'boom' });
    expect(user).toBeNull();
  });
});
