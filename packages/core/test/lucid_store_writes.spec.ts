import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelescopeService } from '../src/service.js';
import {
  createTableStatements,
  DEFAULT_TABLE_NAME,
  type LucidDatabaseLike,
  LucidTelescopeStore,
} from '../src/stores/lucid.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';

/** Wrap a Lucid db so every INSERT statement (one `insert()` call) is counted. */
function countInserts(lucid: LucidDatabaseLike, poisonType?: string) {
  const inserts: number[] = [];
  const db: LucidDatabaseLike = {
    from: (table) => lucid.from(table),
    rawQuery: (sql, bindings) => lucid.rawQuery(sql, bindings),
    table: (table) => ({
      insert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (table === DEFAULT_TABLE_NAME) inserts.push(list.length);
        if (poisonType !== undefined && list.some((row) => row.type === poisonType)) {
          return Promise.reject(new Error('rejected row'));
        }
        return lucid.table(table).insert(rows);
      },
    }),
  };
  return { db, inserts };
}

/** Insert `count` rows directly, `createdAt(i)` epoch-ms each, sequence `i`. */
async function seedRows(
  harness: TestHarness,
  count: number,
  createdAt: (i: number) => number,
  idPrefix = 'id',
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(6, '0')}`,
    type: 'query',
    family_hash: null,
    content: '{}',
    tags: '[]',
    sequence: i,
    duration_ms: null,
    origin: 'manual',
    trace_id: null,
    created_at: createdAt(i),
  }));
  for (let i = 0; i < rows.length; i += 90) {
    await harness.lucid.table(DEFAULT_TABLE_NAME).insert(rows.slice(i, i + 90));
  }
}

/** Every SQL statement the harness connection runs from now on. */
function captureQueries(harness: TestHarness): string[] {
  const statements: string[] = [];
  const knex = (
    harness.db.connection() as unknown as {
      getWriteClient(): { on(event: string, fn: (q: { sql: string }) => void): void };
    }
  ).getWriteClient();
  knex.on('query', (query) => statements.push(query.sql));
  return statements;
}

describe('LucidTelescopeStore writes', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('writes a burst of entries in a few multi-row INSERTs', async () => {
    const { db, inserts } = countInserts(harness.lucid);
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await store.count();

    await Promise.all(
      Array.from({ length: 200 }, (_, i) => store.record({ type: 'query', content: { i } })),
    );

    expect(await store.count()).toBe(200);
    // 200 rows at most 90 per statement: three INSERTs, not two hundred.
    expect(inserts).toEqual([90, 90, 20]);
  });

  it('resolves record() only once its entry is persisted', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    const entry = await store.record({ type: 'request', content: { url: '/a' } });
    expect((await store.get(entry.id))?.content).toEqual({ url: '/a' });
  });

  it('fails only the record() whose row the database rejects', async () => {
    const { db } = countInserts(harness.lucid, 'poison');
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await store.count();

    const results = await Promise.allSettled([
      store.record({ type: 'query', content: 1 }),
      store.record({ type: 'poison', content: 2 }),
      store.record({ type: 'query', content: 3 }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(await store.count()).toBe(2);
  });

  it('drops and counts entries once the write buffer is full, instead of queueing them', async () => {
    const stalled: LucidDatabaseLike = {
      from: (table) => harness.lucid.from(table),
      rawQuery: (sql, bindings) => harness.lucid.rawQuery(sql, bindings),
      table: (table) =>
        table === DEFAULT_TABLE_NAME
          ? { insert: () => new Promise(() => {}) }
          : harness.lucid.table(table),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new LucidTelescopeStore(stalled, { autoCreateTable: true });
    await store.count();

    // One batch is in flight against the stalled database; the rest wait.
    void store.record({ type: 'query', content: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 10_050; i++) void store.record({ type: 'query', content: i });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.droppedCount).toBe(50);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('prunes a backlog larger than any bind limit, keeping the newest keepLast', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.count();
    const total = 40_000;
    await seedRows(harness, total, (i) => 1_000 + Math.floor(i / 3));

    // Everything is older than the cutoff; the newest 10 survive.
    const deleted = await store.prune(new Date(1_000_000), 10);

    expect(deleted).toBe(total - 10);
    const kept = await store.list();
    expect(kept.map((e) => e.sequence)).toEqual(
      Array.from({ length: 10 }, (_, i) => total - 1 - i),
    );
  });

  it('prunes without keepLast in bounded batches, oldest first', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.count();
    await seedRows(harness, 12_000, (i) => 1_000 + i);
    await seedRows(harness, 5, (i) => 50_000 + i, 'newer');
    const statements = captureQueries(harness);

    expect(await store.prune(new Date(20_000))).toBe(12_000);

    expect(await store.count()).toBe(5);
    // 5,000 rows per DELETE.
    expect(statements.filter((sql) => /^delete/i.test(sql))).toHaveLength(3);
  });

  it('reads without content when the caller says it does not need it', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.record({ type: 'query', content: { sql: 'select 1' }, tags: ['a'] });

    const [light] = await store.list({ omitContent: true });
    const [full] = await store.list();

    expect(light).toEqual({ ...full, content: null });
  });

  it('counts families in SQL, busiest first, ties to the most recently seen', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    for (const family of ['a', 'b', 'b', 'c', 'a', 'd']) {
      await store.record({
        type: family === 'd' ? 'other' : 'query',
        familyHash: family,
        content: {},
      });
    }
    await store.record({ type: 'query', content: {} });

    expect(await store.countFamilies({ limit: 10 })).toEqual([
      { key: 'a', count: 2 },
      { key: 'b', count: 2 },
      { key: 'd', count: 1 },
      { key: 'c', count: 1 },
    ]);
    expect(await store.countFamilies({ limit: 1, type: 'query' })).toEqual([
      { key: 'a', count: 2 },
    ]);
  });

  it('counts tags across pages, ties to the most recently seen', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.record({ type: 'query', content: {}, tags: ['x', 'lib:a'] });
    await store.record({ type: 'query', content: {}, tags: ['y', 'lib:b'] });
    await store.record({ type: 'query', content: {}, tags: ['x'] });

    expect(await store.countTags({ limit: 3 })).toEqual([
      { key: 'x', count: 2 },
      { key: 'y', count: 1 },
      { key: 'lib:b', count: 1 },
    ]);
    expect(await store.countTags({ limit: 5, prefix: 'lib:' })).toEqual([
      { key: 'lib:b', count: 1 },
      { key: 'lib:a', count: 1 },
    ]);
  });

  it('groups the throughput buckets in SQL', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    const start = Date.now() - 1;
    for (let i = 0; i < 5; i++) await store.record({ type: i % 2 ? 'a' : 'b', content: i });
    const statements = captureQueries(harness);

    const rows = await store.countByBucket({
      after: new Date(start),
      before: new Date(Date.now() + 1),
      bucketMs: 60_000,
    });

    expect(rows.sort((x, y) => x.type.localeCompare(y.type))).toEqual([
      { index: 0, type: 'a', count: 2 },
      { index: 0, type: 'b', count: 3 },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/group by/i);
  });

  it('serves the per-type newest-first read from one index, without sorting', async () => {
    for (const stmt of createTableStatements()) await harness.lucid.rawQuery(stmt);
    const plan = (await harness.lucid.rawQuery(
      `EXPLAIN QUERY PLAN SELECT * FROM "${DEFAULT_TABLE_NAME}" WHERE "type" = ? AND "created_at" > ? ORDER BY "created_at" DESC, "sequence" DESC LIMIT 50`,
      ['query', 0],
    )) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');

    expect(details).toContain('type_created_at_sequence_idx');
    expect(details).not.toMatch(/TEMP B-TREE/);
  });

  it('answers /api/stats aggregates without listing the table', async () => {
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.record({ type: 'query', familyHash: 'f', content: { big: 'x' }, tags: ['t'] });
    const list = vi.spyOn(store, 'list');
    const service = new TelescopeService(store);

    expect(await service.topFamilies(5, 'query')).toEqual([{ key: 'f', count: 1 }]);
    expect(await service.topTags(5)).toEqual([{ key: 't', count: 1 }]);
    expect(list).not.toHaveBeenCalled();
  });

  it('ships the composite indexes in the migration stub', () => {
    const stub = readFileSync(
      new URL('../stubs/database/migrations/create_telescope_entries_table.stub', import.meta.url),
      'utf8',
    );
    expect(stub).toContain("table.index(['type', 'created_at', 'sequence'])");
    expect(stub).toContain("table.index(['family_hash', 'created_at'])");
  });

  it('adds the composite indexes to an existing table on first use', async () => {
    // Only the table, without its indexes.
    await harness.lucid.rawQuery(createTableStatements()[0]!);
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await store.count();

    const indexes = (await harness.lucid.rawQuery(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      [DEFAULT_TABLE_NAME],
    )) as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        `${DEFAULT_TABLE_NAME}_type_created_at_sequence_idx`,
        `${DEFAULT_TABLE_NAME}_family_hash_created_at_idx`,
      ]),
    );
  });
});
