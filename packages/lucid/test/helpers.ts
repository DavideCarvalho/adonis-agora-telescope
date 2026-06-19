import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import type { LucidDatabaseLike } from '../src/lucid_store.js';

/**
 * Build a standalone Lucid `Database` ("using Lucid outside an app") against a
 * file-based `better-sqlite3` database. A temp *file* (not `:memory:`) lets the
 * persistence test reconnect with a brand-new `Database` + store and still see
 * the rows — proving entries survive a process restart.
 *
 * The store itself only ever touches Lucid's async query builder; `better-sqlite3`
 * is just the test driver Lucid talks to.
 */
export function makeDatabase(file: string): Database {
  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: file },
          useNullAsDefault: true,
        },
      },
    },
    new Logger({ enabled: false }),
    // Emitter generics are app-specific; tests don't need them.
    new Emitter(undefined as any),
  );
}

export interface TestHarness {
  db: Database;
  /** The Lucid db typed as the structural surface the store consumes. */
  lucid: LucidDatabaseLike;
  dir: string;
  file: string;
  /** Open a fresh `Database` against the same file (simulates a reconnect). */
  reconnect: () => Database;
  cleanup: () => Promise<void>;
}

export async function makeHarness(): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'telescope-lucid-'));
  const file = join(dir, 'telescope.sqlite');
  const db = makeDatabase(file);
  const open: Database[] = [db];

  const reconnect = () => {
    const next = makeDatabase(file);
    open.push(next);
    return next;
  };

  const cleanup = async () => {
    for (const instance of open) await instance.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    db,
    lucid: db as unknown as LucidDatabaseLike,
    dir,
    file,
    reconnect,
    cleanup,
  };
}
