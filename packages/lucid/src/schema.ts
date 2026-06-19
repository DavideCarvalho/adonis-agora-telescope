/**
 * The table {@link LucidTelescopeStore} reads and writes. Override via
 * {@link LucidStoreOptions.tableName} when `telescope_entries` collides with an
 * existing table.
 */
export const DEFAULT_TABLE_NAME = 'telescope_entries';

/**
 * The column layout, kept in one place so the DDL helper, the migration stub and
 * the store's queries can never drift apart.
 *
 * - `content` / `tags` are JSON text columns (portable across every Lucid dialect).
 * - `family_hash` is the grouping key used by `topFamilies`; `trace_id` powers
 *   trace correlation; `created_at` is stored as epoch milliseconds so newest-first
 *   ordering and age-based pruning are a plain integer comparison (no timezone or
 *   string-format ambiguity across drivers).
 */
export interface TelescopeColumns {
  id: string;
  type: string;
  family_hash: string | null;
  content: string;
  tags: string;
  sequence: number;
  duration_ms: number | null;
  origin: string;
  trace_id: string | null;
  created_at: number;
}

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the telescope entries table, plus the
 * indexes `list` / `prune` / `topFamilies` lean on, as one statement per array
 * element so each can be issued through Lucid's `rawQuery`.
 *
 * Portable across sqlite / Postgres / MySQL (quoted identifiers, no dialect-only
 * column types). A real deployment should still prefer the bundled migration stub
 * so the schema is versioned, but this lets a store stand itself up in tests and
 * scripts without a migration runner.
 */
export function createTableStatements(tableName: string = DEFAULT_TABLE_NAME): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS "${tableName}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "type" VARCHAR(255) NOT NULL,
      "family_hash" VARCHAR(255) NULL,
      "content" TEXT NOT NULL,
      "tags" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "duration_ms" INTEGER NULL,
      "origin" VARCHAR(255) NOT NULL,
      "trace_id" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_created_at_idx" ON "${tableName}" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_type_idx" ON "${tableName}" ("type")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_trace_id_idx" ON "${tableName}" ("trace_id")`,
    `CREATE INDEX IF NOT EXISTS "${tableName}_family_hash_idx" ON "${tableName}" ("family_hash")`,
  ];
}
