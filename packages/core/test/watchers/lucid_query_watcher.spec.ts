import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { detectNPlusOne } from '../../src/query/n_plus_one.js';
import { setTelescopePaused, setTelescopeRuntime } from '../../src/registry.js';
import {
  buildQueryEntry,
  DB_QUERY_EVENT,
  type DbQueryEventLike,
  LucidQueryWatcher,
  type QueryEntryContent,
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
      // Bindings are redacted by default (arity preserved) — see captureBindings.
      expect(content.bindings).toEqual(['[REDACTED]']);
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
      const { duration: _noDuration, ...event } = dbQueryEvent();
      const input = buildQueryEntry(event);
      expect((input.content as QueryEntryContent).durationMs).toBeNull();
      expect(input.durationMs).toBeNull();
    });

    it('redacts bound values by default, preserving arity', () => {
      const input = buildQueryEntry(dbQueryEvent({ bindings: ['secret@example.com', 42] }));
      const content = input.content as QueryEntryContent;
      expect(content.bindings).toEqual(['[REDACTED]', '[REDACTED]']);
      expect(content.bindings).not.toContain('secret@example.com');
    });

    it('captures the raw bound values when captureBindings is on', () => {
      const input = buildQueryEntry(dbQueryEvent({ bindings: ['a@b.com', 42] }), {
        captureBindings: true,
      });
      expect((input.content as QueryEntryContent).bindings).toEqual(['a@b.com', 42]);
    });

    it('tags a query at/above the slow threshold', () => {
      const slow = buildQueryEntry(dbQueryEvent({ duration: [0, 700_000_000] }), { slowMs: 500 });
      expect(slow.tags).toContain('slow');
      const fast = buildQueryEntry(dbQueryEvent({ duration: [0, 1_000_000] }), { slowMs: 500 });
      expect(fast.tags).not.toContain('slow');
    });

    it('hashes SQL verbatim (no template grouping) when normalize is off', () => {
      const a = buildQueryEntry(dbQueryEvent({ sql: 'select * from users where id = 1' }), {
        normalize: false,
      });
      const b = buildQueryEntry(dbQueryEvent({ sql: 'select * from users where id = 999' }), {
        normalize: false,
      });
      expect(a.familyHash).not.toBe(b.familyHash);
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
      expect(content.bindings).toEqual(['[REDACTED]']);
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

    it('does not record queries on an ignored connection', async () => {
      const watcher = new LucidQueryWatcher({ ignoreConnections: ['replica'] });
      watcher.start(emitter);

      await emitter.emit(DB_QUERY_EVENT, dbQueryEvent({ connection: 'replica' }));
      await emitter.emit(DB_QUERY_EVENT, dbQueryEvent({ connection: 'primary' }));
      await flush();

      const entries = await store.list({ type: EntryType.Query });
      expect(entries).toHaveLength(1);
      expect((entries[0]!.content as QueryEntryContent).connection).toBe('primary');
    });

    it('sheds new entries while the runtime is paused', async () => {
      // The overload guard flips the shed flag; safeRecord must honour it.
      setTelescopePaused(true);
      const watcher = new LucidQueryWatcher();
      watcher.start(emitter);

      await emitter.emit(DB_QUERY_EVENT, dbQueryEvent());
      await flush();

      expect(await store.count()).toBe(0);
    });

    it('feeds the Pulse slow-query + N+1 cards (familyHash + durationMs)', async () => {
      const watcher = new LucidQueryWatcher({ slowMs: 500 });
      watcher.start(emitter);

      // One driving parent, then the same child template N times (classic N+1).
      await emitter.emit(
        DB_QUERY_EVENT,
        dbQueryEvent({ sql: 'select * from "posts"', method: 'select' }),
      );
      for (let id = 1; id <= 5; id++) {
        await emitter.emit(
          DB_QUERY_EVENT,
          dbQueryEvent({ sql: `select * from "users" where "id" = ${id}`, method: 'select' }),
        );
      }
      // A genuinely slow query so the slow-query card has something to show.
      await emitter.emit(
        DB_QUERY_EVENT,
        dbQueryEvent({ sql: 'select count(*) from "logs"', duration: [0, 800_000_000] }),
      );
      await flush();

      const entries = await store.list({ type: EntryType.Query });
      // Every entry must carry a groupable familyHash + a numeric durationMs.
      for (const entry of entries) {
        expect(entry.familyHash).toBeTypeOf('string');
        expect(entry.durationMs).toBeTypeOf('number');
      }

      // N+1: the repeated child template surfaces once, counted 5×.
      const insights = detectNPlusOne(entries, 3);
      expect(insights).toHaveLength(1);
      expect(insights[0]?.count).toBe(5);

      // Slow-query card: at least one entry is tagged `slow`.
      const slow = entries.filter((entry) => entry.tags.includes('slow'));
      expect(slow.length).toBeGreaterThanOrEqual(1);
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
