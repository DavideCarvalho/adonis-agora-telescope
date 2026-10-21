import type { ApplicationService } from '@adonisjs/core/types';
import { durationToMs } from '../alerts/parse_duration.js';
import type { TelescopeStore } from '../store.js';
import type { LucidDatabaseLike, LucidStoreOptions } from './lucid.js';
import type { InMemoryStoreOptions } from './memory.js';
import type { ParquetColdStore } from './parquet.js';
import type { DuckDbEngineOptions } from './parquet_duckdb.js';
import type { ColdObjectStore, S3LocationOptions } from './parquet_location.js';

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
 * Where the Parquet cold tier keeps its files: a local directory, an S3 bucket through
 * the host's own `S3Client`, or any {@link ColdObjectStore}.
 */
export type ParquetLocationConfig = { dir: string } | { s3: S3LocationOptions } | ColdObjectStore;

/**
 * Which engine reads the cold tier:
 *
 * - `'hyparquet'` (default) — pure JavaScript, nothing native, nothing downloaded.
 * - `'duckdb'` / `{ duckdb: { ... } }` — `@duckdb/node-api` (an optional peer), faster on
 *   wide scans. Boot fails if it is selected but not installed; there is no silent
 *   fallback. It never loads DuckDB's `httpfs`/`aws` extensions.
 */
export type ParquetEngineConfig = 'hyparquet' | 'duckdb' | { duckdb: DuckDbEngineOptions };

/** Options for the `parquet` cold-tier driver (used as `storage.tiered({ cold })`). */
export interface ParquetStoreConfig {
  location: ParquetLocationConfig;
  /** Default `'hyparquet'`. */
  engine?: ParquetEngineConfig;
  /** Written into file names and rows. Default `<hostname>-<pid>`. */
  instanceId?: string;
  /** Rows per row group. Default 10,000. */
  rowGroupSize?: number;
  /** Rows per file. Default 200,000. */
  maxRowsPerFile?: number;
}

/** A configured cold tier: a thunk the tiered driver calls at boot. */
export type ColdStoreProvider = (ctx: StoreContext) => Promise<ParquetColdStore>;

/** Options for the `tiered` store driver. */
export interface TieredStoreConfig {
  /** The hot tier: any driver from this factory (usually `storage.lucid()`) or a store. */
  hot: StoreProvider | TelescopeStore;
  /** The cold tier, `storage.parquet({ ... })`. */
  cold: ColdStoreProvider;
  /**
   * How long entries stay hot before `prune` moves them to cold, e.g. `'5m'`. Must be
   * shorter than `prune.after`, which becomes the cold tier's retention.
   */
  hotFor: string | number;
  /** Hot entries read per page while moving. Default 5,000. */
  moveBatchSize?: number;
  /** Entries buffered before a move writes them out as files. Default 50,000. */
  moveFlushSize?: number;
  /** Merge each closed hour's files during prune. Default `true`. */
  compact?: boolean;
}

/**
 * The store factory namespace used in `config/telescope.ts`:
 *
 * ```ts
 * import { defineConfig, storage } from '@adonis-agora/telescope'
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
    return async ({ app }) => {
      const { LucidTelescopeStore } = await import('./lucid.js');

      // Resolve the `Database` singleton from the container (lucid aliases it as
      // `lucid.db` in its REGISTER phase, so it is available here at provider boot).
      // We deliberately do NOT read `@adonisjs/lucid/services/db`: that façade's
      // default export is populated only inside `app.booted()`, which runs AFTER
      // every provider's `boot()` — so at the moment the telescope provider builds
      // the store it would still be `undefined` and crash on `.connection`.
      const db = (await app.container.make('lucid.db')) as {
        connection(name: string): unknown;
      };

      // Bind to a single connection client when named, else the Database facade. Both
      // satisfy the structural LucidDatabaseLike surface the store consumes.
      const client = config.connection ? db.connection(config.connection) : db;
      const { connection: _connection, ...storeOptions } = config;
      return new LucidTelescopeStore(client as unknown as LucidDatabaseLike, storeOptions);
    };
  },

  /**
   * The Parquet cold tier for {@link storage.tiered}: hourly-partitioned files in a
   * directory or an S3 bucket. `hyparquet`, `hyparquet-writer` and
   * `hyparquet-compressors` are optional peers, imported only when this is built;
   * `@duckdb/node-api` too, and only for `engine: 'duckdb'`.
   */
  parquet(config: ParquetStoreConfig): ColdStoreProvider {
    return async () => {
      const [{ ParquetColdStore, loadParquetLibs }, locations] = await Promise.all([
        import('./parquet.js'),
        import('./parquet_location.js'),
      ]);
      const libs = await loadParquetLibs();
      const location =
        'dir' in config.location && typeof config.location.dir === 'string'
          ? new locations.DirectoryLocation(config.location.dir)
          : 's3' in config.location
            ? new locations.S3Location(config.location.s3)
            : (config.location as ColdObjectStore);
      const engine = config.engine ?? 'hyparquet';
      return ParquetColdStore.create({
        location,
        libs,
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
        ...(config.rowGroupSize !== undefined ? { rowGroupSize: config.rowGroupSize } : {}),
        ...(config.maxRowsPerFile !== undefined ? { maxRowsPerFile: config.maxRowsPerFile } : {}),
        engine: async (context) => {
          if (engine === 'hyparquet') {
            const { HyparquetEngine } = await import('./parquet_hyparquet.js');
            return new HyparquetEngine(context);
          }
          const { DuckDbEngine } = await import('./parquet_duckdb.js');
          return DuckDbEngine.create(context, engine === 'duckdb' ? {} : engine.duckdb);
        },
      });
    };
  },

  /**
   * Hot + cold: entries are recorded into `hot` and moved to `cold` (Parquet) by the
   * pruner once older than `hotFor`; reads span both. Needs a `prune` block — its
   * `after` is the cold tier's retention.
   *
   * ```ts
   * stores: {
   *   tiered: storage.tiered({
   *     hot: storage.lucid(),
   *     cold: storage.parquet({ location: { dir: 'storage/telescope' } }),
   *     hotFor: '5m',
   *   }),
   * },
   * prune: { after: '7d', intervalMs: 60_000 },
   * ```
   */
  tiered(config: TieredStoreConfig): StoreProvider {
    return async (ctx) => {
      const hotForMs = durationToMs(config.hotFor);
      const [{ TieredTelescopeStore }, hot, cold] = await Promise.all([
        import('./tiered.js'),
        typeof config.hot === 'function' ? config.hot(ctx) : Promise.resolve(config.hot),
        config.cold(ctx),
      ]);
      return new TieredTelescopeStore({
        hot,
        cold,
        hotForMs,
        ...(config.moveBatchSize !== undefined ? { moveBatchSize: config.moveBatchSize } : {}),
        ...(config.moveFlushSize !== undefined ? { moveFlushSize: config.moveFlushSize } : {}),
        ...(config.compact !== undefined ? { compact: config.compact } : {}),
      });
    };
  },
};
