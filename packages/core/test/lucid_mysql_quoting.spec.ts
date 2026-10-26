import knex, { type Knex } from 'knex';
import { describe, expect, it } from 'vitest';
import {
  createTableStatements,
  createTelescopeTable,
  type LucidDatabaseLike,
  LucidTelescopeStore,
} from '../src/stores/lucid.js';

/**
 * A Lucid-shaped db on a knex MySQL client with no connection: every statement is
 * compiled to the SQL MySQL would receive and recorded instead of run. Reads
 * resolve to no rows.
 */
function compilingMysqlDb(): { db: LucidDatabaseLike; sql: string[] } {
  const client = knex({ client: 'mysql2' });
  const sql: string[] = [];
  const record = (builder: Knex.QueryBuilder | Knex.Raw) => {
    sql.push(builder.toString());
    return Promise.resolve([]);
  };
  const capture = (builder: Knex.QueryBuilder) => {
    // `first()` and the aggregate/select calls all return the builder; awaiting it compiles it.
    Object.defineProperty(builder, 'then', {
      value: (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
        record(builder).then(resolve, reject),
    });
    return builder;
  };
  const db = {
    dialect: { name: 'mysql2' },
    from: (table: string) => capture(client.queryBuilder().from(table)),
    table: (table: string) => ({
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) =>
        record(client(table).insert(rows)),
    }),
    rawQuery: (statement: string, bindings?: unknown[]) =>
      record(
        bindings === undefined ? client.raw(statement) : client.raw(statement, bindings as never),
      ),
  };
  return { db: db as unknown as LucidDatabaseLike, sql };
}

describe('lucid store SQL on MySQL', () => {
  it('quotes the tag and search filter columns as identifiers', async () => {
    const { db, sql } = compilingMysqlDb();
    const store = new LucidTelescopeStore(db);

    await store.list({ tag: 'lib:billing', search: '50%_off' });

    const select = sql.find((statement) => statement.startsWith('select *'))!;
    expect(select).toContain('`tags` LIKE');
    expect(select).toContain('LOWER(`content`) LIKE');
    expect(select).toContain("'%50!%!_off%'");
    expect(select).not.toContain('"tags"');
    expect(select).not.toContain('"content"');
    expect(select).not.toContain("ESCAPE '\\'");
  });

  it('creates the table and indexes with backtick-quoted identifiers and no IF NOT EXISTS on indexes', async () => {
    const { db, sql } = compilingMysqlDb();

    await createTelescopeTable(db);
    await new LucidTelescopeStore(db, { autoCreateTable: true }).count();

    const ddl = sql.filter((statement) => /^CREATE/.test(statement));
    expect(ddl.length).toBeGreaterThanOrEqual(6);
    for (const statement of ddl) expect(statement).not.toContain('"');
    expect(ddl.filter((statement) => statement.startsWith('CREATE INDEX IF NOT EXISTS'))).toEqual(
      [],
    );
    expect(ddl).toContain(
      'CREATE INDEX `telescope_entries_type_created_at_sequence_idx` ON `telescope_entries` (`type`, `created_at`, `sequence`)',
    );
    expect(
      ddl.some((statement) =>
        statement.startsWith('CREATE TABLE IF NOT EXISTS `telescope_schema_meta`'),
      ),
    ).toBe(true);
  });

  it('keeps double-quoted DDL for the other dialects', () => {
    const [table, index] = createTableStatements('t', 'pg');
    expect(table).toContain('CREATE TABLE IF NOT EXISTS "t"');
    expect(index).toBe('CREATE INDEX IF NOT EXISTS "t_created_at_idx" ON "t" ("created_at")');
  });
});
