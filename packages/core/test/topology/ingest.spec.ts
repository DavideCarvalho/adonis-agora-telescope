import { describe, expect, it, vi } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { resolveIngestLimits } from '../../src/topology/config.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';

const wire = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'log',
  familyHash: null,
  content: { message: id },
  tags: ['level:info'],
  durationMs: null,
  origin: 'http',
  traceId: 't-1',
  createdAt: new Date().toISOString(),
  ...extra,
});

function setup(options: { limits?: Parameters<typeof resolveIngestLimits>[0] } = {}) {
  const store = new InMemoryTelescopeStore();
  const onRefused = vi.fn();
  const handler = createIngestHandler({
    verifyTenant: sharedSecretVerifier({
      partitions: {
        shop: { secret: 'shop-secret', environment: 'production' },
        billing: 'billing-secret',
        reader: { secret: 'reader-secret', capabilities: ['telescope:read'] },
      },
    }),
    store: () => store,
    limits: resolveIngestLimits(options.limits),
    onRefused,
  });
  return { store, handler, onRefused };
}

describe('server: ingest', () => {
  it('stores each entry tagged with the app (and environment) from the token', async () => {
    const { store, handler } = setup();
    const res = await handler.ingest({
      token: 'shop-secret',
      app: 'shop',
      body: { version: 1, entries: [wire('1'), wire('2', { type: 'request', durationMs: 12 })] },
    });
    expect(res).toEqual({ status: 202, body: { accepted: 2, duplicates: 0, rejected: 0 } });
    const rows = await store.list();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tags).toEqual(['level:info', 'app:shop', 'env:production']);
      expect(row.traceId).toBe('t-1');
      expect(row.origin).toBe('http');
    }
    expect(rows.find((r) => r.type === 'request')?.durationMs).toBe(12);
  });

  it('refuses a missing or bad token (401) and a token without telescope:ingest (403)', async () => {
    const { store, handler, onRefused } = setup();
    const body = { entries: [wire('1')] };
    expect((await handler.ingest({ app: 'shop', body })).status).toBe(401);
    expect((await handler.ingest({ token: 'nope', app: 'shop', body })).status).toBe(401);
    // The right secret for the wrong app.
    expect((await handler.ingest({ token: 'shop-secret', app: 'billing', body })).status).toBe(401);
    expect((await handler.ingest({ token: 'reader-secret', app: 'reader', body })).status).toBe(
      403,
    );
    expect(onRefused).toHaveBeenCalledWith(
      'missing the telescope:ingest capability',
      expect.objectContaining({ partition: 'reader' }),
    );
    expect(await store.count()).toBe(0);
  });

  it('ignores any app or environment the body claims: the token decides', async () => {
    const { store, handler } = setup();
    await handler.ingest({
      token: 'billing-secret',
      app: 'billing',
      body: {
        partition: 'shop',
        app: 'shop',
        entries: [wire('1', { tags: ['app:shop', 'env:production', 'app:admin', 'keep:me'] })],
      },
    });
    const [row] = await store.list();
    expect(row?.tags).toEqual(['keep:me', 'app:billing']);
  });

  it('a batch sent twice is stored once (idempotent by entry id, per app)', async () => {
    const { store, handler } = setup();
    const body = { entries: [wire('a'), wire('b'), wire('a')] };
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).body).toEqual({
      accepted: 2,
      duplicates: 1,
      rejected: 0,
    });
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).body).toEqual({
      accepted: 0,
      duplicates: 3,
      rejected: 0,
    });
    // The same id from another app is another entry.
    await handler.ingest({
      token: 'billing-secret',
      app: 'billing',
      body: { entries: [wire('a')] },
    });
    expect(await store.count()).toBe(3);
  });

  it('validates every entry and size-limits the batch', async () => {
    const { store, handler } = setup({
      limits: { maxEntries: 3, maxEntryBytes: 100, maxBodyBytes: 1000 },
    });
    const bad = [
      wire('', {}),
      wire('x', { type: 'bad type!' }),
      wire('y', { tags: 'nope' }),
      { id: 'z' },
    ];
    expect(
      (
        await handler.ingest({
          token: 'shop-secret',
          app: 'shop',
          body: { entries: bad.slice(0, 3) },
        })
      ).body,
    ).toEqual({ accepted: 0, duplicates: 0, rejected: 3 });
    expect(
      (
        await handler.ingest({
          token: 'shop-secret',
          app: 'shop',
          body: {
            entries: [wire('big', { content: 'x'.repeat(200) }), wire('ok', { origin: '??' })],
          },
        })
      ).body,
    ).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    expect((await store.list())[0]?.origin).toBe('manual');
    expect(
      (await handler.ingest({ token: 'shop-secret', app: 'shop', body: { entries: bad } })).status,
    ).toBe(413);
    expect(
      (await handler.ingest({ token: 'shop-secret', app: 'shop', contentLength: 5000, body: {} }))
        .status,
    ).toBe(413);
    expect(
      (await handler.ingest({ token: 'shop-secret', app: 'shop', body: { nope: 1 } })).status,
    ).toBe(400);
    expect(
      (
        await handler.ingest({
          token: 'shop-secret',
          app: 'shop',
          body: { version: 2, entries: [] },
        })
      ).status,
    ).toBe(400);
  });

  it('503 when the store is not running or the verifier cannot answer', async () => {
    const noStore = createIngestHandler({
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 's' } }),
      store: () => null,
    });
    expect((await noStore.ingest({ token: 's', app: 'shop', body: { entries: [] } })).status).toBe(
      503,
    );
    const down = createIngestHandler({
      verifyTenant: async () => {
        throw new Error('issuer unreachable');
      },
      store: () => new InMemoryTelescopeStore(),
    });
    expect((await down.ingest({ token: 's', body: { entries: [] } })).status).toBe(503);
  });

  it('caps a body without content-length, refuses an unsafe app name, answers 503 when the store throws', async () => {
    const { handler } = setup({ limits: { maxBodyBytes: 500 } });
    const big = { entries: [wire('a', { content: 'x'.repeat(600) })] };
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body: big })).status).toBe(
      413,
    );

    const longName = createIngestHandler({
      verifyTenant: () => ({ partition: 'a'.repeat(200), capabilities: ['telescope:ingest'] }),
      store: () => new InMemoryTelescopeStore(),
    });
    expect((await longName.ingest({ token: 't', body: { entries: [wire('1')] } })).status).toBe(
      403,
    );

    const failing = createIngestHandler({
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 's' } }),
      store: () =>
        ({
          record: async () => {
            throw new Error('disk full');
          },
        }) as never,
    });
    expect(
      (await failing.ingest({ token: 's', app: 'shop', body: { entries: [wire('1')] } })).status,
    ).toBe(503);
  });

  it('refuses an expired token and answers whoami from the token', async () => {
    const handler = createIngestHandler({
      verifyTenant: ({ token }) =>
        token === 'old'
          ? { partition: 'shop', capabilities: ['telescope:*'], expiresAt: Date.now() - 1 }
          : { partition: 'shop', environment: 'staging', capabilities: ['telescope:*'] },
      store: () => new InMemoryTelescopeStore(),
    });
    expect((await handler.ingest({ token: 'old', body: { entries: [] } })).status).toBe(401);
    expect(await handler.whoami({ token: 'new', app: 'spoofed' })).toEqual({
      status: 200,
      body: { partition: 'shop', environment: 'staging' },
    });
  });
});
