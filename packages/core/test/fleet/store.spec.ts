import { afterEach, describe, expect, it } from 'vitest';
import {
  type FleetStore,
  type InstanceRecord,
  instancesTableStatements,
  LucidFleetStore,
  MemoryFleetStore,
} from '../../src/index.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    app: 'shop',
    instanceId: 'web-1-1-aaaa',
    environment: 'production',
    host: 'web-1',
    pid: 1,
    version: 'v1',
    bootedAt: NOW - 60_000,
    firstSeenAt: NOW - 50_000,
    lastSeenAt: NOW,
    state: 'ready',
    intervalMs: 15_000,
    url: 'https://shop.internal',
    role: 'web',
    checks: [
      {
        name: 'redis',
        status: 'down',
        message: 'OOM',
        since: NOW - 1000,
        checkedAt: NOW,
        durationMs: 3,
        critical: true,
      },
    ],
    shipping: { buffered: 2, dropped: 1, sent: 9, failures: 0, lagMs: 50, lastError: null },
    ...overrides,
  };
}

const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const kinds: Record<string, () => Promise<FleetStore>> = {
  memory: async () => new MemoryFleetStore(),
  lucid: async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    return new LucidFleetStore(harness.lucid, { autoCreateTable: true });
  },
};

describe.each(Object.keys(kinds))('%s fleet store', (kind) => {
  const make = kinds[kind] as () => Promise<FleetStore>;

  it('upserts by app + instance id and round-trips every field', async () => {
    const store = await make();
    await store.upsert(record());
    await store.upsert(record({ lastSeenAt: NOW + 15_000, state: 'draining' }));
    await store.upsert(record({ app: 'billing' }));
    const rows = await store.list();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.app === 'shop')).toEqual(
      record({ lastSeenAt: NOW + 15_000, state: 'draining' }),
    );
  });

  it('keeps the first seen time (created) on every upsert; last seen (updated) moves', async () => {
    const store = await make();
    await store.upsert(record());
    await store.upsert(record({ firstSeenAt: NOW + 15_000, lastSeenAt: NOW + 15_000 }));
    const [row] = await store.list();
    expect(row?.firstSeenAt).toBe(NOW - 50_000);
    expect(row?.lastSeenAt).toBe(NOW + 15_000);
  });

  it('keeps each instance role (a worker next to the web process)', async () => {
    const store = await make();
    await store.upsert(record());
    await store.upsert(record({ instanceId: 'worker-1', role: 'durable:work' }));
    const roles = (await store.list()).map((r) => [r.instanceId, r.role]).sort();
    expect(roles).toEqual([
      ['web-1-1-aaaa', 'web'],
      ['worker-1', 'durable:work'],
    ]);
  });

  it('keeps the watchers an instance reports, and none for an older sender', async () => {
    const store = await make();
    await store.upsert(record({ watchers: ['query', 'request'] }));
    await store.upsert(record({ instanceId: 'old' }));
    const rows = await store.list();
    expect(rows.find((r) => r.instanceId === 'web-1-1-aaaa')?.watchers).toEqual([
      'query',
      'request',
    ]);
    expect(rows.find((r) => r.instanceId === 'old')).not.toHaveProperty('watchers');
  });

  it('lists by app and since; prunes by last seen', async () => {
    const store = await make();
    await store.upsert(record({ instanceId: 'old', lastSeenAt: NOW - 100_000 }));
    await store.upsert(record({ instanceId: 'new' }));
    await store.upsert(record({ app: 'billing', instanceId: 'b' }));
    expect((await store.list({ apps: ['shop'] })).map((r) => r.instanceId).sort()).toEqual([
      'new',
      'old',
    ]);
    expect(await store.list({ apps: [] })).toEqual([]);
    expect((await store.list({ since: NOW - 10_000 })).length).toBe(2);
    expect(await store.prune(NOW - 10_000)).toBe(1);
    expect((await store.list()).map((r) => r.instanceId).sort()).toEqual(['b', 'new']);
  });
});

describe('lucid fleet store rows written before roles', () => {
  it('reads a row without a role as a web instance', async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    const store = new LucidFleetStore(harness.lucid, { autoCreateTable: true });
    await store.upsert(record());
    const data = JSON.parse(
      String((await harness.db.from('telescope_instances').select('data'))[0]?.data),
    ) as Record<string, unknown>;
    delete data.role;
    await harness.db.from('telescope_instances').update({ data: JSON.stringify(data) });
    expect((await store.list())[0]?.role).toBe('web');
  });
});

describe('memory fleet store damaged first seen', () => {
  it('a non-finite stored first seen time falls back to the heartbeat one', async () => {
    const store = new MemoryFleetStore();
    await store.upsert(record({ firstSeenAt: Number.NaN }));
    await store.upsert(record({ firstSeenAt: NOW + 15_000, lastSeenAt: NOW + 15_000 }));
    expect((await store.list())[0]?.firstSeenAt).toBe(NOW + 15_000);
  });
});

describe('lucid fleet store first seen across processes', () => {
  it('a restarted receiver (a new store) keeps the stored first seen time', async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    await new LucidFleetStore(harness.lucid, { autoCreateTable: true }).upsert(record());
    // A new process: its registry only knows the instance from this heartbeat on.
    const restarted = new LucidFleetStore(harness.lucid, { autoCreateTable: true });
    await restarted.upsert(record({ firstSeenAt: NOW + 30_000, lastSeenAt: NOW + 30_000 }));
    await restarted.upsert(record({ firstSeenAt: NOW + 30_000, lastSeenAt: NOW + 45_000 }));
    const [row] = await restarted.list();
    expect(row?.firstSeenAt).toBe(NOW - 50_000);
    expect(row?.lastSeenAt).toBe(NOW + 45_000);
  });

  it('a prune that deletes nothing keeps the cached first seen time (no re-read)', async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    const store = new LucidFleetStore(harness.lucid, { autoCreateTable: true });
    await store.upsert(record());
    // Changed behind the store's back: a re-read would pick it up.
    await harness.db.from('telescope_instances').update({ first_seen_at: NOW - 999_999 });
    expect(await store.prune(NOW - 100_000)).toBe(0);
    await store.upsert(record({ firstSeenAt: NOW + 15_000, lastSeenAt: NOW + 15_000 }));
    expect((await store.list())[0]?.firstSeenAt).toBe(NOW - 50_000);
  });

  it('a damaged stored first seen time falls back to the heartbeat one', async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    await new LucidFleetStore(harness.lucid, { autoCreateTable: true }).upsert(record());
    await harness.db.from('telescope_instances').update({ first_seen_at: 'garbage' });
    const restarted = new LucidFleetStore(harness.lucid, { autoCreateTable: true });
    await restarted.upsert(record({ firstSeenAt: NOW + 30_000, lastSeenAt: NOW + 30_000 }));
    expect((await restarted.list())[0]?.firstSeenAt).toBe(NOW + 30_000);
  });

  it('a pruned instance that comes back starts a new first seen time', async () => {
    const harness = await makeHarness();
    harnesses.push(harness);
    const store = new LucidFleetStore(harness.lucid, { autoCreateTable: true });
    await store.upsert(record());
    expect(await store.prune(NOW + 1)).toBe(1);
    await store.upsert(record({ firstSeenAt: NOW + 60_000, lastSeenAt: NOW + 60_000 }));
    expect((await store.list())[0]?.firstSeenAt).toBe(NOW + 60_000);
  });
});

describe('instances table DDL', () => {
  it('names the schema in every statement (no search_path), per dialect', () => {
    const pg = instancesTableStatements(undefined, 'postgres', 'telescope');
    expect(pg[0]).toContain('CREATE TABLE IF NOT EXISTS "telescope"."telescope_instances"');
    expect(pg[1]).toContain('ON "telescope"."telescope_instances"');
    expect(pg[1]).toContain('IF NOT EXISTS');
    const mysql = instancesTableStatements(undefined, 'mysql2', 'telescope');
    expect(mysql[0]).toContain('`telescope`.`telescope_instances`');
    expect(mysql[1]).not.toContain('IF NOT EXISTS');
    expect(instancesTableStatements('fleet', 'better-sqlite3')[0]).toContain('"fleet"');
  });

  it('the store qualifies its queries with the schema', async () => {
    const tables: string[] = [];
    const builder = {
      where() {
        return this;
      },
      whereIn() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      select: async () => [],
      delete: async () => 0,
    };
    const db = {
      dialect: { name: 'postgres' },
      from: (table: string) => {
        tables.push(table);
        return builder;
      },
      table: (table: string) => {
        tables.push(table);
        return { insert: async () => undefined };
      },
      rawQuery: async () => ({ rows: [] }),
    };
    const store = new LucidFleetStore(db as never, { schema: 'telescope' });
    await store.upsert(record());
    await store.list();
    await store.prune(0);
    expect(new Set(tables)).toEqual(new Set(['telescope.telescope_instances']));
  });
});
