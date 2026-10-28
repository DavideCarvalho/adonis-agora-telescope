import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INIT_RETRY_DELAY_MS,
  type LucidDatabaseLike,
  LucidTelescopeStore,
  SCHEMA_META_TABLE_NAME,
} from '../src/stores/lucid.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';

/**
 * Several processes booting against a fresh Postgres at once race on
 * `CREATE TABLE IF NOT EXISTS` (it is not atomic there: the loser fails with a unique
 * violation on `pg_type_typname_nsp_index`). That error used to reject the store's
 * cached init promise forever, so every later `record()` failed — and every watcher
 * logged one line per entry for the life of the process.
 */

/** A pg-style concurrent-DDL error, as Lucid/knex surfaces it. */
function raceError(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'),
    { code: '23505' },
  );
}

/** Wrap a Lucid db so `rawQuery` calls matching `match` fail via `fail()` while `failures > 0`. */
function failingRawQuery(
  lucid: LucidDatabaseLike,
  match: (sql: string) => boolean,
  fail: () => Error,
  failures: number,
): { db: LucidDatabaseLike; calls: () => number } {
  let left = failures;
  let calls = 0;
  const db: LucidDatabaseLike = {
    from: (table) => lucid.from(table),
    table: (table) => lucid.table(table),
    rawQuery: (sql, bindings) => {
      if (match(sql)) {
        calls += 1;
        if (left > 0) {
          left -= 1;
          return Promise.reject(fail()) as never;
        }
      }
      return lucid.rawQuery(sql, bindings);
    },
  };
  return { db, calls: () => calls };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanup();
});

describe('LucidTelescopeStore init under concurrent boots', () => {
  it('retries a CREATE TABLE IF NOT EXISTS that lost a race with another process', async () => {
    const { db, calls } = failingRawQuery(
      harness.lucid,
      (sql) => sql.includes(SCHEMA_META_TABLE_NAME),
      raceError,
      1,
    );
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });

    await expect(store.record({ type: 'x', content: 'a' })).resolves.toMatchObject({ type: 'x' });
    expect(calls()).toBe(2);
    expect(await store.list()).toHaveLength(1);
  });

  it('retries the entries-table DDL when it races too', async () => {
    const { db } = failingRawQuery(
      harness.lucid,
      (sql) => sql.includes('CREATE TABLE IF NOT EXISTS "telescope_entries"'),
      raceError,
      2,
    );
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await expect(store.record({ type: 'x', content: 'a' })).resolves.toBeDefined();
  });

  it('does not retry an unrelated DDL error inside the same init', async () => {
    const { db, calls } = failingRawQuery(
      harness.lucid,
      (sql) => sql.includes(SCHEMA_META_TABLE_NAME),
      () => Object.assign(new Error('permission denied for schema public'), { code: '42501' }),
      1,
    );
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await expect(store.record({ type: 'x', content: 'a' })).rejects.toThrow('permission denied');
    expect(calls()).toBe(1);
  });

  it('re-runs a failed init after the retry delay instead of failing forever', async () => {
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);

    const { db, calls } = failingRawQuery(
      harness.lucid,
      (sql) => sql.includes(SCHEMA_META_TABLE_NAME),
      () => new Error('connect ECONNREFUSED'),
      1,
    );
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });

    await expect(store.record({ type: 'x', content: 'a' })).rejects.toThrow('ECONNREFUSED');
    // Inside the delay, callers share the failed attempt — no DDL storm.
    clock += INIT_RETRY_DELAY_MS - 1;
    await expect(store.record({ type: 'x', content: 'b' })).rejects.toThrow('ECONNREFUSED');
    expect(calls()).toBe(1);

    // Past it, the next call initializes for real and writes go through.
    clock += 1;
    await expect(store.record({ type: 'x', content: 'c' })).resolves.toBeDefined();
    expect(calls()).toBe(2);
    expect((await store.list()).map((e) => e.content)).toEqual(['c']);
    now.mockRestore();
  });

  it('tolerates another process writing the schema marker between delete and insert', async () => {
    const lucid = harness.lucid;
    let raced = false;
    const db: LucidDatabaseLike = {
      from: (table) => lucid.from(table),
      rawQuery: (sql, bindings) => lucid.rawQuery(sql, bindings),
      table: (table) => {
        if (table === SCHEMA_META_TABLE_NAME && !raced) {
          raced = true;
          // The "other process" wins the insert first.
          return {
            insert: async (row: Record<string, unknown>) => {
              await lucid.table(table).insert(row);
              return lucid.table(table).insert(row);
            },
          } as never;
        }
        return lucid.table(table);
      },
    };
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await expect(store.record({ type: 'x', content: 'a' })).resolves.toBeDefined();
    expect(raced).toBe(true);
  });
});
