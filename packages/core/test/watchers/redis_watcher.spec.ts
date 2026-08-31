import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  buildRedisEntry,
  type RedisCommandLike,
  type RedisConnectionLike,
  type RedisEntryContent,
  type RedisManagerLike,
  RedisWatcher,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A fake ioredis client whose `sendCommand` resolves with a fixed reply. */
function fakeIoClient(): { sendCommand(command: RedisCommandLike): Promise<unknown> } {
  return {
    sendCommand(_command: RedisCommandLike): Promise<unknown> {
      return Promise.resolve('OK');
    },
  };
}

/** A fake `@adonisjs/redis` connection wrapping a fake ioredis client. */
function fakeConnection(name: string): RedisConnectionLike {
  return { connectionName: name, ioConnection: fakeIoClient() };
}

/** A fake `@adonisjs/redis` manager exposing active connections + a `connection` event. */
function fakeManager(
  active: Record<string, RedisConnectionLike>,
): RedisManagerLike & { added(connection: RedisConnectionLike): void } {
  const listeners = new Set<(connection: RedisConnectionLike) => void>();
  return {
    activeConnections: active,
    on(_event, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    added(connection) {
      for (const listener of listeners) listener(connection);
    },
  };
}

describe('RedisWatcher', () => {
  afterEach(() => clearStore());

  describe('buildRedisEntry', () => {
    it('shapes a redis entry with upper-cased command, args and connection', () => {
      const input = buildRedisEntry({ name: 'get', args: ['user:1'] }, 'main', 3);
      expect(input.type).toBe(EntryType.Redis);
      const content = input.content as RedisEntryContent;
      expect(content.command).toBe('GET');
      expect(content.args).toEqual(['user:1']);
      expect(content.connection).toBe('main');
      expect(content.durationMs).toBe(3);
      expect(input.familyHash).toBe('redis:GET');
      expect(input.tags).toContain('redis');
      expect(input.tags).toContain('redis:GET');
      expect(input.tags).toContain('connection:main');
    });
  });

  describe('start/stop against a fake manager', () => {
    let store: ReturnType<typeof installStore>;

    beforeEach(() => {
      store = installStore();
    });

    it('records a redis entry per command on active connections', async () => {
      const conn = fakeConnection('main');
      const manager = fakeManager({ main: conn });
      const watcher = new RedisWatcher(manager);
      watcher.start();

      const client = conn.ioConnection as ReturnType<typeof fakeIoClient>;
      await client.sendCommand({ name: 'set', args: ['k', 'v'] });
      await client.sendCommand({ name: 'get', args: ['k'] });
      await flush();

      const entries = await store.list({ type: EntryType.Redis });
      expect(entries).toHaveLength(2);
      const commands = entries.map((e) => (e.content as RedisEntryContent).command).sort();
      expect(commands).toEqual(['GET', 'SET']);

      watcher.stop();
    });

    it('instruments connections created after start()', async () => {
      const manager = fakeManager({});
      const watcher = new RedisWatcher(manager);
      watcher.start();

      const conn = fakeConnection('cache');
      manager.added(conn);
      const client = conn.ioConnection as ReturnType<typeof fakeIoClient>;
      await client.sendCommand({ name: 'del', args: ['k'] });
      await flush();

      const entries = await store.list({ type: EntryType.Redis });
      expect(entries).toHaveLength(1);
      expect((entries[0]!.content as RedisEntryContent).command).toBe('DEL');

      watcher.stop();
    });

    it('restores the original sendCommand on stop() and never records after', async () => {
      const conn = fakeConnection('main');
      const client = conn.ioConnection as ReturnType<typeof fakeIoClient>;
      const original = client.sendCommand;
      const manager = fakeManager({ main: conn });
      const watcher = new RedisWatcher(manager);
      watcher.start();
      expect(client.sendCommand).not.toBe(original);

      watcher.stop();
      expect(client.sendCommand).toBe(original);

      await client.sendCommand({ name: 'get', args: ['k'] });
      await flush();
      expect(await store.count()).toBe(0);
    });
  });

  it('no-ops when the manager is absent (optional peer missing)', () => {
    installStore();
    const watcher = new RedisWatcher(null);
    expect(() => watcher.start()).not.toThrow();
    watcher.stop();
  });

  it('redacts a sensitive argument value in the stored entry', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    const conn = fakeConnection('main');
    const manager = fakeManager({ main: conn });
    const watcher = new RedisWatcher(manager);
    watcher.start();

    const client = conn.ioConnection as ReturnType<typeof fakeIoClient>;
    await client.sendCommand({ name: 'hset', args: ['session', { token: 'supersecret' }] });
    await flush();

    const entries = await inner.list({ type: EntryType.Redis });
    expect(entries).toHaveLength(1);
    const args = (entries[0]!.content as RedisEntryContent).args as unknown[];
    expect(args[1]).toEqual({ token: '[REDACTED]' });

    watcher.stop();
  });
});
