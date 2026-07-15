import { describe, expect, it, vi } from 'vitest';
import { resolveClientErrors } from '../../src/client_errors/config.js';
import {
  type ClientErrorHttpContext,
  ClientErrorIngestor,
  storeRecorder,
} from '../../src/client_errors/ingestor.js';
import type { ClientExceptionContent } from '../../src/client_errors/validation.js';
import { EntryType, type RecordInput } from '../../src/entry.js';
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
