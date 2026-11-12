import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkDbSchema } from '../src/doctor/checks.js';
import {
  createTelescopeTable,
  DEFAULT_TABLE_NAME,
  type LucidDatabaseLike,
  LucidTelescopeStore,
  SCHEMA_META_TABLE_NAME,
} from '../src/stores/lucid.js';
import { rowsOf } from '../src/stores/sql_schema.js';

/**
 * The `schema` option against real Postgres and MySQL: the tables live in a schema (a MySQL
 * database) other than the connection's default, and nothing lands in the default one.
 *
 * Runs when `TELESCOPE_TEST_PG_URL` / `TELESCOPE_TEST_MYSQL_URL` are set (CI sets both), e.g.
 * `postgres://postgres:postgres@127.0.0.1:5432/postgres` and `mysql://root:root@127.0.0.1:3306/app`.
 */
const targets = [
  { name: 'postgres', client: 'pg', url: process.env.TELESCOPE_TEST_PG_URL },
  { name: 'mysql', client: 'mysql2', url: process.env.TELESCOPE_TEST_MYSQL_URL },
] as const;

/** A table reference in captured SQL: `telescope_entries` / `telescope_schema_meta`, not an index name. */
const TABLE_REF = /(.)?(telescope_entries|telescope_schema_meta)(?![A-Za-z0-9_])/g;

for (const target of targets) {
  describe.skipIf(!target.url)(`lucid store with schema (${target.name})`, () => {
    const mysql = target.client === 'mysql2';
    const quote = mysql ? '`' : '"';
    let db: Database;
    let schema: string;
    let statements: string[] = [];

    const lucid = () => db.connection('main') as unknown as LucidDatabaseLike;
    const raw = async (sql: string, bindings: unknown[] = []) =>
      rowsOf(await db.connection('main').rawQuery(sql, bindings as never));

    /** Tables named like telescope's in `where` (a schema / database name). */
    const tablesIn = async (where: string): Promise<string[]> =>
      (
        await raw(
          'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?) ORDER BY table_name',
          [where, DEFAULT_TABLE_NAME, SCHEMA_META_TABLE_NAME],
        )
      ).map((row) => String(row.name));

    /** The connection's own default schema / database. */
    const defaultSchema = async (): Promise<string> => {
      const rows = await raw(
        mysql ? 'SELECT DATABASE() AS name' : 'SELECT current_schema() AS name',
      );
      return String(rows[0]?.name);
    };

    beforeAll(async () => {
      db = new Database(
        {
          connection: 'main',
          connections: { main: { client: target.client, connection: target.url } as never },
        },
        new Logger({ enabled: false }),
        new Emitter(undefined as any),
      );
      // Every statement the connection sends, to prove none of them is unqualified.
      const knex = db.connection('main').getWriteClient() as unknown as {
        on(event: 'query', listener: (query: { sql: string }) => void): void;
      };
      knex.on('query', (query) => statements.push(query.sql));
    });

    afterAll(async () => {
      await db?.manager.closeAll();
    });

    afterEach(async () => {
      if (schema === undefined) return;
      await raw(
        mysql
          ? `DROP DATABASE IF EXISTS \`${schema}\``
          : `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
    });

    const freshSchema = () => {
      schema = `tscope_${randomBytes(4).toString('hex')}`;
      statements = [];
      return schema;
    };

    /** Every table reference in the captured SQL is `<schema>.<table>`. */
    const expectAllQualified = () => {
      const unqualified: string[] = [];
      for (const sql of statements) {
        for (const match of sql.matchAll(TABLE_REF)) {
          const before = sql.slice(0, match.index + (match[1] === undefined ? 0 : 1));
          if (!before.endsWith(`${quote}${schema}${quote}.${quote}`)) unqualified.push(sql);
        }
      }
      expect(unqualified).toEqual([]);
      expect(statements.length).toBeGreaterThan(0);
    };

    it('creates the schema and its tables there, and reads/writes only there', async () => {
      freshSchema();
      const store = new LucidTelescopeStore(lucid(), { autoCreateTable: true, schema });

      const a = await store.record({
        type: 'query',
        content: { sql: 'select 1' },
        familyHash: 'f1',
        tags: ['lib:billing'],
        traceId: 'trace-1',
        durationMs: 3,
      });
      await store.record({
        type: 'query',
        content: { n: 2 },
        familyHash: 'f1',
        traceId: 'trace-1',
      });
      await store.record({ type: 'request', content: { path: '/' }, tags: ['lib:billing'] });

      expect(await tablesIn(schema)).toEqual([DEFAULT_TABLE_NAME, SCHEMA_META_TABLE_NAME].sort());
      expect(await tablesIn(await defaultSchema())).toEqual([]);

      expect((await store.get(a.id))?.content).toEqual({ sql: 'select 1' });
      expect(await store.count()).toBe(3);
      expect(await store.list({ type: 'query' })).toHaveLength(2);
      expect(await store.list({ tag: 'lib:billing', omitContent: true })).toHaveLength(2);
      expect(await store.list({ search: 'select' })).toHaveLength(1);
      expect((await store.listTraceIds({ size: 10 })).map((row) => row.traceId)).toEqual([
        'trace-1',
      ]);
      expect(await store.countFamilies({ limit: 5 })).toEqual([{ key: 'f1', count: 2 }]);
      expect(await store.countTags({ limit: 5 })).toEqual([{ key: 'lib:billing', count: 2 }]);
      const buckets = await store.countByBucket({
        after: new Date(Date.now() - 60_000),
        before: new Date(Date.now() + 1_000),
        bucketMs: 60_000,
      });
      expect(buckets.reduce((sum, row) => sum + row.count, 0)).toBe(3);

      expect(await store.prune(new Date(Date.now() + 1_000), 1)).toBe(2);
      expect(await store.count()).toBe(1);
      await store.clear();
      expect(await store.count()).toBe(0);

      expectAllQualified();
    });

    it('keeps the sequence across a restart and skips the DDL once the fingerprint matches', async () => {
      freshSchema();
      const first = new LucidTelescopeStore(lucid(), { autoCreateTable: true, schema });
      const one = await first.record({ type: 'x', content: 1 });

      statements = [];
      const second = new LucidTelescopeStore(lucid(), { autoCreateTable: true, schema });
      const two = await second.record({ type: 'x', content: 2 });

      expect(two.sequence).toBeGreaterThan(one.sequence);
      expect(
        statements.some((sql) => /CREATE TABLE/i.test(sql) && sql.includes(DEFAULT_TABLE_NAME)),
      ).toBe(false);
      expectAllQualified();
    });

    it("works inside the app's own transaction", async () => {
      freshSchema();
      await createTelescopeTable(lucid(), { schema });
      const trx = await db.connection('main').transaction();
      const store = new LucidTelescopeStore(trx as unknown as LucidDatabaseLike, { schema });
      const entry = await store.record({ type: 'trx', content: { ok: true } });
      await trx.commit();

      const reader = new LucidTelescopeStore(lucid(), { schema });
      expect((await reader.get(entry.id))?.type).toBe('trx');
      expect(await tablesIn(await defaultSchema())).toEqual([]);
      expectAllQualified();
    });

    it('reports the schema to agora:doctor', async () => {
      freshSchema();
      const store = new LucidTelescopeStore(lucid(), { autoCreateTable: true, schema });
      const before = await checkDbSchema(store);
      expect(before[0]?.status).toBe('error');
      expect(before[0]?.message).toContain('does not exist');

      await store.count();
      const after = await checkDbSchema(store);
      expect(after.map((result) => result.status)).toEqual(['ok']);

      // A schema that exists but holds no telescope table.
      const empty = new LucidTelescopeStore(lucid(), { schema, tableName: 'tscope_missing' });
      const missing = await checkDbSchema(empty);
      expect(missing[0]?.status).toBe('error');
      expect(missing[0]?.message).toContain('tscope_missing');

      // Without a schema: no result at all.
      expect(await checkDbSchema(new LucidTelescopeStore(lucid()))).toEqual([]);
    });
  });
}
