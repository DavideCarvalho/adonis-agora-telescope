/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

import {
  type LucidDatabaseLike,
  type LucidStoreOptions,
  LucidTelescopeStore,
} from './lucid_store.js';

export { LucidTelescopeStore } from './lucid_store.js';
export type {
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  LucidStoreOptions,
} from './lucid_store.js';

export { createTelescopeTable } from './migration.js';
export type { CreateTableOptions } from './migration.js';

export { DEFAULT_TABLE_NAME, createTableStatements } from './schema.js';
export type { TelescopeColumns } from './schema.js';

/**
 * Build a persistent {@link LucidTelescopeStore} for `@agora/telescope`'s
 * `config/telescope.ts`:
 *
 * ```ts
 * import db from '@adonisjs/lucid/services/db'
 * import { defineConfig } from '@agora/telescope'
 * import { lucidTelescopeStore } from '@agora/telescope-lucid'
 *
 * export default defineConfig({ store: lucidTelescopeStore(db) })
 * ```
 */
export function lucidTelescopeStore(
  db: LucidDatabaseLike,
  options?: LucidStoreOptions,
): LucidTelescopeStore {
  return new LucidTelescopeStore(db, options);
}
