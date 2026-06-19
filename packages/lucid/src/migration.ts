import type { LucidDatabaseLike } from './lucid_store.js';
import { DEFAULT_TABLE_NAME, createTableStatements } from './schema.js';

/** Options for {@link createTelescopeTable}. */
export interface CreateTableOptions {
  /** Table to create. Defaults to `telescope_entries`. */
  tableName?: string;
}

/**
 * Stand up the telescope entries table (and its indexes) through Lucid's async
 * query runner, idempotently (`CREATE TABLE IF NOT EXISTS`). Works on every Lucid
 * dialect. Handy for tests, scripts and quick-starts where running a full
 * migration is overkill.
 *
 * Production apps should prefer the bundled migration stub so the schema is
 * versioned and runs through `node ace migration:run`.
 */
export async function createTelescopeTable(
  db: LucidDatabaseLike,
  options: CreateTableOptions = {},
): Promise<void> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  for (const stmt of createTableStatements(tableName)) {
    await db.rawQuery(stmt);
  }
}

export { createTableStatements, DEFAULT_TABLE_NAME } from './schema.js';
