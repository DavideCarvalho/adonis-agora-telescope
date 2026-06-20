import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { type CacheEntryContent, CacheWatcher, buildCacheEntry } from '../../src/watchers/index.js';
import {
  clearStore,
  fakeEmitter,
  flush,
  installStore,
  realEmitter,
  throwingStore,
} from './helpers.js';

describe('CacheWatcher', () => {
  afterEach(() => clearStore());

  describe('buildCacheEntry', () => {
    it('shapes a cache entry with operation, key and store', () => {
      const input = buildCacheEntry('hit', { key: 'user:1', store: 'redis' });
      expect(input.type).toBe(EntryType.Cache);
      const content = input.content as CacheEntryContent;
      expect(content.operation).toBe('hit');
      expect(content.key).toBe('user:1');
      expect(content.store).toBe('redis');
      expect(input.familyHash).toBe('hit:user:1');
      expect(input.tags).toContain('cache:hit');
      expect(input.tags).toContain('store:redis');
    });

    it('falls back to the operation as familyHash without a key', () => {
      const input = buildCacheEntry('clear', {});
      expect(input.familyHash).toBe('clear');
      expect((input.content as CacheEntryContent).key).toBeNull();
    });
  });

  describe('start/stop against the real Adonis emitter', () => {
    let store: ReturnType<typeof installStore>;
    let emitter: ReturnType<typeof realEmitter>;

    beforeEach(() => {
      store = installStore();
      emitter = realEmitter();
    });

    it('records cache entries for hit/miss/write events', async () => {
      const watcher = new CacheWatcher();
      watcher.start(emitter);

      await emitter.emit('cache:hit', { key: 'a', store: 'memory' });
      await emitter.emit('cache:miss', { key: 'b', store: 'memory' });
      await emitter.emit('cache:written', { key: 'c', store: 'memory' });
      await flush();

      const entries = await store.list({ type: EntryType.Cache });
      expect(entries).toHaveLength(3);
      const ops = entries.map((e) => (e.content as CacheEntryContent).operation).sort();
      expect(ops).toEqual(['hit', 'miss', 'write']);
    });

    it('stops recording after stop()', async () => {
      const watcher = new CacheWatcher();
      watcher.start(emitter);
      watcher.stop();

      await emitter.emit('cache:hit', { key: 'a' });
      await flush();

      expect(await store.count()).toBe(0);
    });

    it('honours a custom event map', async () => {
      const watcher = new CacheWatcher({ 'my:cache:hit': 'hit' });
      watcher.start(emitter);

      await emitter.emit('my:cache:hit', { key: 'z' });
      await emitter.emit('cache:hit', { key: 'ignored' });
      await flush();

      const entries = await store.list({ type: EntryType.Cache });
      expect(entries).toHaveLength(1);
      expect((entries[0]?.content as CacheEntryContent).key).toBe('z');
    });
  });

  it('never throws into the emit when the store rejects', async () => {
    setTelescopeRuntime(throwingStore(), true);
    const emitter = fakeEmitter();
    const watcher = new CacheWatcher();
    watcher.start(emitter);

    expect(() => emitter.emit('cache:hit', { key: 'a' })).not.toThrow();
    await flush();
  });
});
