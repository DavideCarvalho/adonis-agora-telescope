import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTableStatements,
  createTelescopeTable,
  type LucidDatabaseLike,
  LucidTelescopeStore,
} from '../src/stores/lucid.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A fake client of `dialect` that records raw SQL and never touches a database. */
function fakeClient(dialect: string): LucidDatabaseLike {
  return {
    dialect: { name: dialect },
    from: () => {
      throw new Error('unused');
    },
    table: () => {
      throw new Error('unused');
    },
    rawQuery: async () => [],
  };
}

describe('the lucid store `schema` option', () => {
  it('fails at boot on SQLite, naming the schema', () => {
    const connection = harness.db.connection('primary') as unknown as LucidDatabaseLike;
    expect(() => new LucidTelescopeStore(connection, { schema: 'telescope' })).toThrow(
      /schema: "telescope".*better-sqlite3, which has no schemas/,
    );
  });

  it('fails on SQLite through the Database facade too', async () => {
    expect(() => new LucidTelescopeStore(harness.lucid, { schema: 'telescope' })).toThrow(
      /has no schemas/,
    );
    await expect(createTelescopeTable(harness.lucid, { schema: 'telescope' })).rejects.toThrow(
      /has no schemas/,
    );
  });

  it.each(['', '1abc', 'a.b', 'a-b', 'a"b', 'x'.repeat(64)])(
    'rejects the schema name %j',
    (schema) => {
      expect(() => new LucidTelescopeStore(fakeClient('postgres'), { schema })).toThrow(
        /must be a plain identifier/,
      );
    },
  );

  it('accepts a 63-character name with digits, _ and $', () => {
    const schema = `a_1$${'x'.repeat(59)}`;
    expect(new LucidTelescopeStore(fakeClient('postgres'), { schema }).schema).toBe(schema);
  });

  it('leaves everything unqualified without a schema', () => {
    const store = new LucidTelescopeStore(harness.lucid);
    expect(store.schema).toBeUndefined();
    expect(createTableStatements()[0]).toContain('CREATE TABLE IF NOT EXISTS "telescope_entries"');
  });

  it('qualifies the table, not the index names, in the DDL', () => {
    const [pgTable, pgIndex] = createTableStatements('t', 'postgres', 'obs');
    expect(pgTable).toContain('CREATE TABLE IF NOT EXISTS "obs"."t"');
    expect(pgIndex).toBe(
      'CREATE INDEX IF NOT EXISTS "t_created_at_idx" ON "obs"."t" ("created_at")',
    );

    const [myTable, myIndex] = createTableStatements('t', 'mysql2', 'obs');
    expect(myTable).toContain('CREATE TABLE IF NOT EXISTS `obs`.`t`');
    expect(myIndex).toBe('CREATE INDEX `t_created_at_idx` ON `obs`.`t` (`created_at`)');
  });
});
