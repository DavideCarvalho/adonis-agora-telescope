import { describe, expect, it, vi } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { resolveIngestLimits } from '../../src/topology/config.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { relayScope, sharedSecretVerifier } from '../../src/topology/verify.js';

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

  it('hands the whole batch to the store before awaiting any write (one INSERT, not one per entry)', async () => {
    const { store, handler } = setup();
    const original = store.record.bind(store);
    let inFlight = 0;
    let maxInFlight = 0;
    store.record = (async (input: Parameters<typeof original>[0]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return original(input);
    }) as typeof store.record;
    const body = { entries: [wire('a'), wire('b'), wire('c'), wire('d')] };
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).body).toEqual({
      accepted: 4,
      duplicates: 0,
      rejected: 0,
    });
    expect(maxInFlight).toBe(4);
    expect(await store.count()).toBe(4);
  });

  it('a failed write answers 503; the entries that were stored are deduped on the retry', async () => {
    const { store, handler } = setup();
    const original = store.record.bind(store);
    let failOnce = true;
    store.record = (async (input: Parameters<typeof original>[0]) => {
      if (input.id === 'shop:b' && failOnce) {
        failOnce = false;
        throw new Error('database blip');
      }
      return original(input);
    }) as typeof store.record;
    const body = { entries: [wire('a'), wire('b'), wire('c')] };
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).status).toBe(503);
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).body).toEqual({
      accepted: 1,
      duplicates: 2,
      rejected: 0,
    });
    expect(await store.count()).toBe(3);
  });

  it('a store that throws synchronously answers 503 instead of escaping', async () => {
    const { store, handler } = setup();
    store.record = (() => {
      throw new Error('not async');
    }) as unknown as typeof store.record;
    const body = { entries: [wire('a'), wire('b')] };
    expect((await handler.ingest({ token: 'shop-secret', app: 'shop', body })).status).toBe(503);
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
      // `telescope:*` implies relaying for any app.
      body: { partition: 'shop', environment: 'staging', relay: '*' },
    });
  });
});

describe('server: relaying entries for other apps', () => {
  function relaySetup() {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: sharedSecretVerifier({
        partitions: {
          durable: {
            secret: 'durable-secret',
            environment: 'production',
            capabilities: ['telescope:ingest:relay'],
          },
          scoped: {
            secret: 'scoped-secret',
            capabilities: ['telescope:ingest', 'telescope:ingest:relay:shop'],
          },
          admin: { secret: 'admin-secret', capabilities: ['telescope:*'] },
          other: { secret: 'other-secret', capabilities: ['telescope:ingest:relay'] },
          shop: { secret: 'shop-secret', environment: 'production' },
          billing: 'billing-secret',
        },
      }),
      store: () => store,
    });
    const send = (token: string, app: string, entries: unknown[]) =>
      handler.ingest({ token, app, body: { version: 1, entries } });
    return { store, handler, send };
  }

  it('stores an entry tagged app:<name> as that app, with via:<relayer>', async () => {
    const { store, send } = relaySetup();
    const res = await send('durable-secret', 'durable', [
      wire('1', { tags: ['workflow:charge', 'app:shop'] }),
      wire('2', { tags: ['workflow:own'] }),
    ]);
    expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    const relayed = await store.get('durable~shop:1');
    // No env: tag on the entry: the environment comes from the relayer's token.
    expect(relayed?.tags).toEqual(['workflow:charge', 'app:shop', 'env:production', 'via:durable']);
    // Without an app: tag the entry is the relayer's own, as before.
    expect((await store.get('durable:2'))?.tags).toEqual([
      'workflow:own',
      'app:durable',
      'env:production',
    ]);
    expect(await store.list({ tag: 'app:shop' })).toHaveLength(1);
  });

  it("keeps a relayed entry's env: tag; a relayer naming itself is not relaying", async () => {
    const { store, send } = relaySetup();
    await send('durable-secret', 'durable', [
      wire('1', { tags: ['app:billing', 'env:staging'] }),
      wire('2', { tags: ['app:durable', 'env:staging', 'via:someone'] }),
    ]);
    expect((await store.get('durable~billing:1'))?.tags).toEqual([
      'app:billing',
      'env:staging',
      'via:durable',
    ]);
    expect((await store.get('durable:2'))?.tags).toEqual(['app:durable', 'env:production']);
  });

  it('without the capability, app:/env:/via: tags are replaced from the token (no spoofing)', async () => {
    const { store, send } = relaySetup();
    const res = await send('billing-secret', 'billing', [
      wire('1', { tags: ['app:shop', 'env:production', 'via:durable', 'keep:me'] }),
    ]);
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    const rows = await store.list();
    expect(rows.map((r) => [r.id, r.tags])).toEqual([['billing:1', ['keep:me', 'app:billing']]]);
  });

  it('a scoped relay (telescope:ingest:relay:<app>) relays only for that app', async () => {
    const { store, send } = relaySetup();
    const res = await send('scoped-secret', 'scoped', [
      wire('1', { tags: ['app:shop'] }),
      wire('2', { tags: ['app:billing'] }),
      wire('3'),
    ]);
    // Another app is refused, never silently stored as the relayer's.
    expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: 1 });
    expect((await store.list()).map((r) => r.id).sort()).toEqual(['scoped:3', 'scoped~shop:1']);
  });

  it('telescope:* relays too; invalid or ambiguous app tags are rejected', async () => {
    const { store, send } = relaySetup();
    const res = await send('admin-secret', 'admin', [
      wire('1', { tags: ['app:shop'] }),
      wire('2', { tags: ['app:bad name'] }),
      wire('3', { tags: ['app:shop', 'app:billing'] }),
      wire('4', { tags: ['app:shop', 'env:no spaces'] }),
      wire('5', { tags: ['app:shop', 'env:a', 'env:b'] }),
    ]);
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 4 });
    expect((await store.get('admin~shop:1'))?.tags).toEqual(['app:shop', 'via:admin']);

    // `<relayer>~<app>:<id>` past the store's 255-character id limit is rejected, not renamed.
    const long = createIngestHandler({
      verifyTenant: () => ({ partition: 'r'.repeat(64), capabilities: ['telescope:*'] }),
      store: () => store,
    });
    expect(
      (
        await long.ingest({
          token: 't',
          body: { entries: [wire('x'.repeat(128), { tags: [`app:${'s'.repeat(64)}`] })] },
        })
      ).body,
    ).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
  });

  it('dedupe: per relayer and relayed app; never collides with the app itself or another relayer', async () => {
    const { store, send } = relaySetup();
    const relayed = [wire('a', { tags: ['app:shop'] })];
    expect((await send('durable-secret', 'durable', relayed)).body).toMatchObject({ accepted: 1 });
    // A retry of the same relayed entry is a duplicate.
    expect((await send('durable-secret', 'durable', relayed)).body).toEqual({
      accepted: 0,
      duplicates: 1,
      rejected: 0,
    });
    // Another relayer with the same id for the same app, and the app itself: separate entries.
    expect((await send('other-secret', 'other', relayed)).body).toMatchObject({ accepted: 1 });
    expect((await send('shop-secret', 'shop', [wire('a')])).body).toMatchObject({ accepted: 1 });
    // The relayer's own `a` is yet another one.
    expect((await send('durable-secret', 'durable', [wire('a')])).body).toMatchObject({
      accepted: 1,
    });
    expect((await store.list()).map((r) => r.id).sort()).toEqual([
      'durable:a',
      'durable~shop:a',
      'other~shop:a',
      'shop:a',
    ]);
    expect(await store.list({ tag: 'app:shop' })).toHaveLength(3);
  });

  it('whoami reports what the token may relay', async () => {
    const { handler } = relaySetup();
    expect((await handler.whoami({ token: 'durable-secret', app: 'durable' })).body).toEqual({
      partition: 'durable',
      environment: 'production',
      relay: '*',
    });
    expect((await handler.whoami({ token: 'scoped-secret', app: 'scoped' })).body).toEqual({
      partition: 'scoped',
      relay: ['shop'],
    });
    // A malformed scope names no app, so it grants nothing.
    expect(relayScope(['telescope:ingest:relay:shop:extra', 'telescope:ingest:relay:'])).toBe(null);
    expect(relayScope(['telescope:ingest:relay:a b', 'telescope:ingest:relay:shop'])).toEqual([
      'shop',
    ]);
    expect((await handler.whoami({ token: 'billing-secret', app: 'billing' })).body).toEqual({
      partition: 'billing',
    });
  });
});
