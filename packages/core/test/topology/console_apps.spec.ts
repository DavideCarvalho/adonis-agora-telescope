import { describe, expect, it } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { createIngestHandler } from '../../src/topology/ingest.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { describeAppScope, viewerStore } from '../../src/ui/index.js';

describe('what the server stores, as the console sees it per app', () => {
  it('two apps appear in the App picker; a viewer limited to one never reads the other', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 's1', billing: 's2' } }),
      store: () => store,
    });
    const entry = (id: string) => ({ id, type: 'log', content: { id }, tags: [] });
    await handler.ingest({ token: 's1', app: 'shop', body: { entries: [entry('a')] } });
    await handler.ingest({ token: 's2', app: 'billing', body: { entries: [entry('b')] } });

    const picker = await describeAppScope({ all: true }, store);
    expect(picker?.enabled).toBe(true);
    expect(picker?.apps.map((a) => a.id).sort()).toEqual(['billing', 'shop']);

    const shopOnly = viewerStore(store, { apps: ['shop'] }, { enabled: false, tag: 'tenant' });
    const rows = (await shopOnly.list()) ?? [];
    expect(rows.map((r) => r.tags)).toEqual([['app:shop']]);
  });
});

describe('relayed entries in the App picker', () => {
  it('lists the relayed apps next to the relayer', async () => {
    const store = new InMemoryTelescopeStore();
    const handler = createIngestHandler({
      verifyTenant: sharedSecretVerifier({
        partitions: { durable: { secret: 's', capabilities: ['telescope:ingest:relay'] } },
      }),
      store: () => store,
    });
    await handler.ingest({
      token: 's',
      app: 'durable',
      body: {
        entries: [
          { id: '1', type: 'log', content: {}, tags: ['app:shop'] },
          { id: '2', type: 'log', content: {}, tags: ['app:billing'] },
          { id: '3', type: 'log', content: {}, tags: [] },
        ],
      },
    });
    const picker = await describeAppScope({ all: true }, store);
    expect(picker.apps.map((a) => a.id).sort()).toEqual(['billing', 'durable', 'shop']);
    const shopOnly = viewerStore(store, { apps: ['shop'] }, { enabled: false, tag: 'tenant' });
    expect(((await shopOnly.list()) ?? []).map((r) => r.tags)).toEqual([
      ['app:shop', 'via:durable'],
    ]);
  });
});
