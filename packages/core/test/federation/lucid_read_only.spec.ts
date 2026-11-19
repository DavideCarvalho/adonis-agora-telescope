import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LucidDatabaseLike,
  LucidTelescopeStore,
  READ_ONLY_STORE_ERROR,
} from '../../src/stores/lucid.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';

describe('LucidTelescopeStore read-only view', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('reads the table without creating anything or seeding a sequence, and refuses writes', async () => {
    const owner = new LucidTelescopeStore(h.lucid, { autoCreateTable: true });
    await owner.record({ type: 'log', content: { message: 'hello' } });
    await owner.flush();

    const tables: string[] = [];
    const raws: string[] = [];
    const spied: LucidDatabaseLike = {
      from: (table) => {
        tables.push(table);
        return h.lucid.from(table);
      },
      table: (table) => h.lucid.table(table),
      rawQuery: (sql, bindings) => {
        raws.push(sql);
        return h.lucid.rawQuery(sql, bindings);
      },
    };
    const reader = new LucidTelescopeStore(spied, {
      autoCreateTable: true,
      readOnly: true,
    });
    expect(reader.readOnly).toBe(true);
    const rows = await reader.list({ size: 10 });
    expect(rows.map((row) => row.content)).toEqual([{ message: 'hello' }]);
    // One SELECT on the entries table: no DDL, no marker table, no MAX(sequence).
    expect(tables).toEqual(['telescope_entries']);
    expect(raws).toEqual([]);
    await expect(reader.record({ type: 'log', content: {} })).rejects.toThrow(
      READ_ONLY_STORE_ERROR,
    );
    await expect(reader.prune(new Date())).rejects.toThrow(READ_ONLY_STORE_ERROR);
    await expect(reader.clear()).rejects.toThrow(READ_ONLY_STORE_ERROR);
  });

  it('readOnlyView() keeps the table and schema', async () => {
    const owner = new LucidTelescopeStore(h.lucid, { autoCreateTable: true, tableName: 'tl' });
    await owner.record({ type: 'log', content: { n: 1 } });
    await owner.flush();
    const view = owner.readOnlyView();
    expect(view.readOnly).toBe(true);
    expect(view.readOnlyView()).toBe(view);
    expect(await view.list({ size: 5 })).toHaveLength(1);
  });
});
