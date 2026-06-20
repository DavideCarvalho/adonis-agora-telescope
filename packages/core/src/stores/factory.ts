import type { ApplicationService } from '@adonisjs/core/types';
import type { TelescopeStore } from '../store.js';
import type { LucidDatabaseLike, LucidStoreOptions } from './lucid.js';
import type { InMemoryStoreOptions } from './memory.js';

/**
 * Runtime context a {@link StoreProvider} receives when the telescope provider builds the
 * configured store at boot.
 */
export interface StoreContext {
  /** The booted application — used to resolve connections, services, etc. */
  app: ApplicationService;
}

/**
 * A configured store: a thunk the telescope provider calls at boot to build the active
 * {@link TelescopeStore}. Each factory lazily imports its peer dependency (`@adonisjs/lucid`)
 * inside the thunk, so a driver is only loaded when it is actually selected — keeping those
 * packages optional.
 */
export type StoreProvider = (ctx: StoreContext) => Promise<TelescopeStore>;

/** Options for the `memory` store driver. */
export interface MemoryStoreConfig extends InMemoryStoreOptions {
  /**
   * Hard cap on retained entries. Past it, the oldest entries are evicted (ring-buffer
   * semantics). Alias of {@link InMemoryStoreOptions.maxEntries}. Default 1000.
   */
  limit?: number;
}

/** Options for the `lucid` store driver. */
export interface LucidStoreConfig extends LucidStoreOptions {
  /**
   * `@adonisjs/lucid` connection name to use. Omit to use the default connection. When set,
   * the store binds to that single connection client instead of the `Database` facade.
   */
  connection?: string;
}

/**
 * The store factory namespace used in `config/telescope.ts`:
 *
 * ```ts
 * import { defineConfig, storage } from '@agora/telescope'
 *
 * export default defineConfig({
 *   store: 'memory',
 *   stores: {
 *     memory: storage.memory({ limit: 1000 }),
 *     lucid: storage.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link StoreProvider} — a lazy thunk. Calling it in the config file
 * costs nothing; the peer dependency is only imported when the provider builds the selected
 * store at boot.
 */
export const storage = {
  /** The built-in, dependency-free bounded ring buffer (great for dev/tests). */
  memory(config: MemoryStoreConfig = {}): StoreProvider {
    return async () => {
      const { InMemoryTelescopeStore } = await import('./memory.js');
      const maxEntries = config.limit ?? config.maxEntries;
      return new InMemoryTelescopeStore(maxEntries !== undefined ? { maxEntries } : {});
    };
  },

  /** A persistent, SQL-backed store on `@adonisjs/lucid` (sqlite / Postgres / MySQL). */
  lucid(config: LucidStoreConfig = {}): StoreProvider {
    return async () => {
      const db = (await import('@adonisjs/lucid/services/db')).default;
      const { LucidTelescopeStore } = await import('./lucid.js');

      // Bind to a single connection client when named, else the Database facade. Both
      // satisfy the structural LucidDatabaseLike surface the store consumes.
      const client = config.connection ? db.connection(config.connection) : db;
      const { connection: _connection, ...storeOptions } = config;
      return new LucidTelescopeStore(client as unknown as LucidDatabaseLike, storeOptions);
    };
  },
};
