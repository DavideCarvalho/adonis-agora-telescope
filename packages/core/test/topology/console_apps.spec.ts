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
