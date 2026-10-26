import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../../src/registry.js';
import { type LucidDatabaseLike, LucidTelescopeStore } from '../../src/stores/lucid.js';
import { LucidQueryWatcher } from '../../src/watchers/index.js';
import { realEmitter } from './helpers.js';

/**
 * The query watcher and the lucid store share one `Database` here, with `debug: true`
 * so Lucid reports every query on `db:query` — the setup the watcher docs recommend.
 * The store's own INSERTs must not come back as `query` entries: each one would be
 * recorded through the same store, emit another `db:query`, and never stop.
 */
describe('LucidQueryWatcher + lucid store on the same connection', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    resetTelescopeRuntime();
    await cleanup?.();
    cleanup = null;
  });

  it("does not record the store's own queries", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telescope-self-'));
    const emitter = realEmitter();
    const db = new Database(
      {
        connection: 'primary',
        connections: {
          primary: {
            client: 'better-sqlite3',
            connection: { filename: join(dir, 'telescope.sqlite') },
            useNullAsDefault: true,
            debug: true,
          },
        },
      },
      new Logger({ enabled: false }),
      emitter as unknown as Emitter<any>,
    );
    cleanup = async () => {
      await db.manager.closeAll();
      rmSync(dir, { recursive: true, force: true });
    };
    const store = new LucidTelescopeStore(db as unknown as LucidDatabaseLike, {
      autoCreateTable: true,
    });
    await store.count();
    const watcher = new LucidQueryWatcher();
    // Stop the watcher after a bounded number of recordings, so a loop shows up as a
    // failed assertion instead of a test that never ends.
    let recorded = 0;
    const record = store.record.bind(store);
    store.record = (input) => {
      recorded += 1;
      if (recorded >= 50) watcher.stop();
      return record(input);
    };
    setTelescopeRuntime(store, true);
    watcher.start(emitter);

    // One app query.
    await db.rawQuery('select 1 as one');
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    watcher.stop();

    expect(recorded).toBe(1);

    const entries = await store.list({ type: 'query' });
    expect(entries.map((e) => (e.content as { sql: string }).sql)).toEqual(['select 1 as one']);
  });
});
