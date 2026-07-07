import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LucidDatabaseLike,
  LucidTelescopeStore,
  SCHEMA_META_TABLE_NAME,
} from '../src/stores/lucid.js';
import { type TestHarness, makeHarness } from './lucid_helpers.js';

/**
 * The schema fingerprint gate that wraps the `autoCreateTable` DDL in `doInit`.
 * A file-based sqlite harness lets a SECOND `Database` + store observe the
 * `telescope_schema_meta` marker the first boot wrote, so we can prove the second
 * boot SKIPS the CREATE TABLE / index DDL when the fingerprint matches and RE-RUNS
 * it when the stored fingerprint is stale.
 */

/** The CREATE statement the gate must skip in steady state (the entries table). */
const ENTRIES_CREATE = `CREATE TABLE IF NOT EXISTS "telescope_entries"`;

/**
 * Wrap a Lucid db so every `rawQuery` SQL is recorded, while `from`/`table`
 * delegate untouched. The store only ever calls these three methods.
 */
function recordRawQueries(lucid: LucidDatabaseLike): {
  db: LucidDatabaseLike;
  rawQueries: string[];
} {
  const rawQueries: string[] = [];
  const db: LucidDatabaseLike = {
    from: (table) => lucid.from(table),
    table: (table) => lucid.table(table),
    rawQuery: (sql, bindings) => {
      rawQueries.push(sql);
      return lucid.rawQuery(sql, bindings);
    },
  };
  return { db, rawQueries };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('LucidTelescopeStore schema fingerprint gate', () => {
  it('runs the entries DDL on a fresh database and writes the marker', async () => {
    const { db, rawQueries } = recordRawQueries(harness.lucid);
    const store = new LucidTelescopeStore(db, { autoCreateTable: true });
    await store.record({ type: 'x', content: 'a' });

    // Fresh DB: the entries CREATE TABLE was issued.
    expect(rawQueries.some((sql) => sql.includes(ENTRIES_CREATE))).toBe(true);

    // The marker persisted a single row: a 64-hex sha256 + an epoch-ms applied_at.
    const rows = await harness.lucid
      .from(SCHEMA_META_TABLE_NAME)
      .where('id', 'telescope_entries')
      .select('*');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(rows[0]?.applied_at)).toBeGreaterThan(0);
  });

  it('skips the entries DDL on a second boot when the stored fingerprint matches', async () => {
    // Boot #1 heals + writes the marker.
    const first = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await first.record({ type: 'x', content: 'a' });

    // Sentinel applied_at: only the heal branch rewrites the marker, so if it
    // stays 1 across boot #2 the gate must have skipped the heal.
    await harness.lucid.rawQuery(
      `UPDATE "${SCHEMA_META_TABLE_NAME}" SET "applied_at" = ? WHERE "id" = ?`,
      [1, 'telescope_entries'],
    );

    // Boot #2 on a fresh Database + store against the same file.
    const db2 = harness.reconnect();
    const { db, rawQueries } = recordRawQueries(db2 as unknown as LucidDatabaseLike);
    const second = new LucidTelescopeStore(db, { autoCreateTable: true });
    expect(await second.count()).toBe(1);

    // The entries CREATE TABLE was NOT re-issued (only the marker CREATE was), and
    // the marker row is untouched.
    expect(rawQueries.some((sql) => sql.includes(ENTRIES_CREATE))).toBe(false);
    const rows = await harness.lucid
      .from(SCHEMA_META_TABLE_NAME)
      .where('id', 'telescope_entries')
      .select('*');
    expect(Number(rows[0]?.applied_at)).toBe(1);
  });

  it('re-runs the entries DDL when the stored fingerprint is stale', async () => {
    const first = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await first.record({ type: 'x', content: 'a' });

    // Corrupt the stored fingerprint (as an entity/DDL change since last boot
    // would) and sentinel applied_at.
    await harness.lucid.rawQuery(
      `UPDATE "${SCHEMA_META_TABLE_NAME}" SET "fingerprint" = ?, "applied_at" = ? WHERE "id" = ?`,
      ['stale', 1, 'telescope_entries'],
    );

    const db2 = harness.reconnect();
    const { db, rawQueries } = recordRawQueries(db2 as unknown as LucidDatabaseLike);
    const second = new LucidTelescopeStore(db, { autoCreateTable: true });
    expect(await second.count()).toBe(1);

    // The mismatch forced the entries DDL to re-run, then re-cached a real
    // fingerprint (no longer 'stale', new applied_at).
    expect(rawQueries.some((sql) => sql.includes(ENTRIES_CREATE))).toBe(true);
    const rows = await harness.lucid
      .from(SCHEMA_META_TABLE_NAME)
      .where('id', 'telescope_entries')
      .select('*');
    expect(String(rows[0]?.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.fingerprint).not.toBe('stale');
    expect(Number(rows[0]?.applied_at)).not.toBe(1);
  });

  it('keys the marker by table name so two telescope tables never collide', async () => {
    const entries = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    const audit = new LucidTelescopeStore(harness.lucid, {
      autoCreateTable: true,
      tableName: 'telescope_audit',
    });
    await entries.record({ type: 'x', content: 'a' });
    await audit.record({ type: 'y', content: 'b' });

    const rows = await harness.lucid.from(SCHEMA_META_TABLE_NAME).orderBy('id', 'asc').select('*');
    expect(rows.map((r) => r.id)).toEqual(['telescope_audit', 'telescope_entries']);
    // Different table shapes ⇒ different fingerprints.
    expect(rows[0]?.fingerprint).not.toBe(rows[1]?.fingerprint);
  });
});
