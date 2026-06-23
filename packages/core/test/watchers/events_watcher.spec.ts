import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  type EmitterAnyLike,
  type EventEntryContent,
  EventsWatcher,
  buildEventEntry,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A structural `onAny`-capable emitter double for unit isolation. */
function anyEmitter(): EmitterAnyLike & {
  emit(event: unknown, data: unknown): void;
  listenerCount(): number;
} {
  const listeners = new Set<(event: unknown, data: unknown) => unknown>();
  return {
    onAny(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event, data) {
      for (const listener of listeners) listener(event, data);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe('EventsWatcher', () => {
  afterEach(() => clearStore());

  describe('buildEventEntry', () => {
    it('shapes an event entry with name and payload', () => {
      const input = buildEventEntry('user:registered', { id: 1 });
      expect(input.type).toBe(EntryType.Event);
      const content = input.content as EventEntryContent;
      expect(content.name).toBe('user:registered');
      expect(content.payload).toEqual({ id: 1 });
      expect(input.familyHash).toBe('event:user:registered');
      expect(input.tags).toContain('event');
      expect(input.tags).toContain('event:user:registered');
    });
  });

  describe('start/stop against a wildcard emitter', () => {
    let store: ReturnType<typeof installStore>;
    let emitter: ReturnType<typeof anyEmitter>;

    beforeEach(() => {
      store = installStore();
      emitter = anyEmitter();
    });

    it('records one entry per emitted event', async () => {
      const watcher = new EventsWatcher([]);
      watcher.start(emitter);

      emitter.emit('user:registered', { id: 1 });
      emitter.emit('order:placed', { total: 9 });
      await flush();

      const entries = await store.list({ type: EntryType.Event });
      expect(entries).toHaveLength(2);
      const names = entries.map((e) => (e.content as EventEntryContent).name).sort();
      expect(names).toEqual(['order:placed', 'user:registered']);
    });

    it('honours the ignore-list', async () => {
      const watcher = new EventsWatcher(['db:query', 'mail:sent']);
      watcher.start(emitter);

      emitter.emit('db:query', { sql: 'select 1' });
      emitter.emit('mail:sent', {});
      emitter.emit('user:registered', { id: 1 });
      await flush();

      const entries = await store.list({ type: EntryType.Event });
      expect(entries).toHaveLength(1);
      expect((entries[0]?.content as EventEntryContent).name).toBe('user:registered');
    });

    it('resolves a class-based event to its constructor name', async () => {
      const watcher = new EventsWatcher([]);
      watcher.start(emitter);

      class OrderShipped {}
      emitter.emit(OrderShipped, { id: 7 });
      await flush();

      const entries = await store.list({ type: EntryType.Event });
      expect(entries).toHaveLength(1);
      expect((entries[0]?.content as EventEntryContent).name).toBe('OrderShipped');
    });

    it('stops recording after stop()', async () => {
      const watcher = new EventsWatcher([]);
      watcher.start(emitter);
      watcher.stop();

      emitter.emit('user:registered', { id: 1 });
      await flush();
      expect(await store.count()).toBe(0);
    });
  });

  it('no-ops when the emitter has no onAny', () => {
    installStore();
    const watcher = new EventsWatcher([]);
    expect(() => watcher.start({})).not.toThrow();
    watcher.stop();
  });

  it('redacts a sensitive field in the stored payload', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    const emitter = anyEmitter();
    const watcher = new EventsWatcher([]);
    watcher.start(emitter);

    emitter.emit('user:login', { email: 'a@b.c', password: 'hunter2' });
    await flush();

    const entries = await inner.list({ type: EntryType.Event });
    expect(entries).toHaveLength(1);
    const payload = (entries[0]?.content as EventEntryContent).payload as Record<string, unknown>;
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.email).toBe('a@b.c');
  });
});
