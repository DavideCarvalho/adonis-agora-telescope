import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import {
  DB_QUERY_EVENT,
  type DbQueryEventLike,
  LucidQueryWatcher,
  type QueryEntryContent,
  buildQueryEntry,
} from '../../src/watchers/index.js';
import {
  clearStore,
  fakeEmitter,
  flush,
  installStore,
  realEmitter,
  throwingStore,
} from './helpers.js';

function dbQueryEvent(over: Partial<DbQueryEventLike> = {}): DbQueryEventLike {
  return {
    connection: 'primary',
    sql: 'select * from "users" where "id" = ?',
    method: 'select',
    bindings: [42],
    duration: [0, 2_500_000], // 2.5ms
    model: 'User',
    inTransaction: false,
    ...over,
  };
}

describe('LucidQueryWatcher', () => {
  afterEach(() => clearStore());

  describe('buildQueryEntry', () => {
    it('shapes a query entry with sql, bindings, duration and connection', () => {
      const input = buildQueryEntry(dbQueryEvent());
      expect(input.type).toBe(EntryType.Query);
      const content = input.content as QueryEntryContent;
      expect(content.sql).toBe('select * from "users" where "id" = ?');
      expect(content.bindings).toEqual([42]);
      expect(content.durationMs).toBeCloseTo(2.5, 5);
      expect(content.connection).toBe('primary');
      expect(content.method).toBe('select');
      expect(input.durationMs).toBeCloseTo(2.5, 5);
      expect(input.tags).toContain('connection:primary');
      expect(input.tags).toContain('method:select');
      expect(input.tags).toContain('model:User');
    });

    it('groups the same query template under one familyHash regardless of bindings', () => {
      const a = buildQueryEntry(dbQueryEvent({ sql: 'select * from users where id = 1' }));
      const b = buildQueryEntry(dbQueryEvent({ sql: 'select * from users where id = 999' }));
      expect(a.familyHash).toBe(b.familyHash);
    });

    it('tolerates a missing duration tuple', () => {
      const input = buildQueryEntry(dbQueryEvent({ duration: undefined }));
      expect((input.content as QueryEntryContent).durationMs).toBeNull();
      expect(input.durationMs).toBeNull();
    });
  });

  describe('start/stop against the real Adonis emitter', () => {
    let store: ReturnType<typeof installStore>;
    let emitter: ReturnType<typeof realEmitter>;

    beforeEach(() => {
      store = installStore();
      emitter = realEmitter();
    });

    it('records a query entry on db:query', async () => {
      const watcher = new LucidQueryWatcher();
      watcher.start(emitter);

      await emitter.emit(DB_QUERY_EVENT, dbQueryEvent());
      await flush();

      const entries = await store.list({ type: EntryType.Query });
      expect(entries).toHaveLength(1);
      const content = entries[0]?.content as QueryEntryContent;
      expect(content.sql).toContain('select');
      expect(content.bindings).toEqual([42]);
      expect(content.connection).toBe('primary');
      expect(entries[0]?.durationMs).toBeCloseTo(2.5, 5);
    });

    it('stops recording after stop()', async () => {
      const watcher = new LucidQueryWatcher();
      watcher.start(emitter);
      watcher.stop();

      await emitter.emit(DB_QUERY_EVENT, dbQueryEvent());
      await flush();

      expect(await store.count()).toBe(0);
    });

    it('ignores non-query payloads', async () => {
      const watcher = new LucidQueryWatcher();
      watcher.start(emitter);

      await emitter.emit(DB_QUERY_EVENT, { not: 'a query' });
      await flush();

      expect(await store.count()).toBe(0);
    });
  });

  it('never throws into the emit when the store rejects', async () => {
    setTelescopeRuntime(throwingStore(), true);
    const emitter = fakeEmitter();
    const watcher = new LucidQueryWatcher();
    watcher.start(emitter);

    expect(() => emitter.emit(DB_QUERY_EVENT, dbQueryEvent())).not.toThrow();
    await flush();
  });
});
