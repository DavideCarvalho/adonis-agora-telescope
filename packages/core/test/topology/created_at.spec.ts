import { describe, expect, it, vi } from 'vitest';
import { InMemoryTelescopeStore, type TelescopeStore } from '../../src/index.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { RemoteTelescopeStore } from '../../src/topology/remote_store.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';

const verifyTenant = sharedSecretVerifier({ partitions: { shop: 's1', billing: 's2' } });
const recordedAt = '2026-11-15T09:00:00.000Z';

describe('entries keep the time the app recorded them', () => {
  it('the app sends each entry with its own id and createdAt', async () => {
    const calls: Array<{ entries: Array<{ id: string; createdAt: string }> }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 202 });
    });
    const tee = new InMemoryTelescopeStore();
    const store = new RemoteTelescopeStore({
      url: 'http://central',
      partition: 'shop',
      token: 's1',
      tee,
      fetch: fetch as never,
      buffer: { flushIntervalMs: 60_000 },
    });
    const entry = await store.record({ type: 'log', content: {} });
    await store.flush();
    expect(calls[0]?.entries[0]).toMatchObject({
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
    });
  });

  it('the server writes them through as <app>:<id> with the original createdAt', async () => {
    const record = vi.fn(async (input: unknown) => input);
    const handler = createIngestHandler({
      verifyTenant,
      store: () => ({ record }) as unknown as TelescopeStore,
    });
    const res = await handler.ingest({
      token: 's1',
      app: 'shop',
      body: { entries: [{ id: 'e-1', type: 'log', content: {}, createdAt: recordedAt }] },
    });
    expect(res.status).toBe(202);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shop:e-1', createdAt: recordedAt, tags: ['app:shop'] }),
    );
    // A bad id or a non-string createdAt is refused.
    const bad = await handler.ingest({
      token: 's1',
      app: 'shop',
      body: {
        entries: [
          { id: 'with space', type: 'log', content: {} },
          { id: 'e-2', type: 'log', content: {}, createdAt: 12 },
        ],
      },
    });
    expect(bad.body).toEqual({ accepted: 0, duplicates: 0, rejected: 2 });
  });
});

describe('with a telescope store that keeps createdAt and id', () => {
  it('stores the original time, orders by it, and dedupes across restarts by id', async () => {
    const store = new InMemoryTelescopeStore();
    const now = Date.now();
    const entry = (id: string, at: number) => ({
      id,
      type: 'log',
      content: { id },
      tags: [],
      createdAt: new Date(at).toISOString(),
    });
    const first = createIngestHandler({ verifyTenant, store: () => store });
    // Recorded during an outage, delivered now: an hour old and two minutes old.
    await first.ingest({
      token: 's1',
      app: 'shop',
      body: { entries: [entry('old', now - 3_600_000), entry('recent', now - 120_000)] },
    });
    // Another app may use the same id: it is a different entry.
    await first.ingest({ token: 's2', app: 'billing', body: { entries: [entry('old', now)] } });
    const rows = await store.list();
    expect(rows.map((r) => r.id)).toEqual(['billing:old', 'shop:recent', 'shop:old']);
    expect((await store.get('shop:old'))?.createdAt.getTime()).toBe(now - 3_600_000);

    // A server restart forgets its recent ids; the store still holds the entry.
    const restarted = createIngestHandler({ verifyTenant, store: () => store });
    await restarted.ingest({ token: 's1', app: 'shop', body: { entries: [entry('old', now)] } });
    expect(await store.count()).toBe(3);

    // A far-future time cannot put an entry ahead of the others.
    await restarted.ingest({
      token: 's1',
      app: 'shop',
      body: { entries: [entry('future', now + 86_400_000)] },
    });
    expect((await store.get('shop:future'))?.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
