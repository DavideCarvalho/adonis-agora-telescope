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

/**
 * Filtering exists because of a real incident: `@adonisjs/limiter` issues ~5 redis
 * commands per rate-limited request, and recording all of them produced 211
 * entries/minute — 93% of a 532k-row telescope table, none of it about the app.
 *
 * These tests pin the two things that matter: the command is still EXECUTED when we
 * decline to record it (a watcher that filters must never change behaviour), and the
 * filters are the ones a person would reach for.
 */
describe('RedisWatcher — filtros de ingestão', () => {
  afterEach(() => clearStore());

  /** Runs one command through a started watcher and returns how many entries landed. */
  async function recordedCount(
    options: ConstructorParameters<typeof RedisWatcher>[1],
    command: RedisCommandLike,
    connectionName = 'main',
  ): Promise<{ count: number; reply: unknown }> {
    const store = installStore();
    const conn = fakeConnection(connectionName);
    const manager = fakeManager({ [connectionName]: conn });
    const watcher = new RedisWatcher(manager, options);
    watcher.start();

    const client = conn.ioConnection as ReturnType<typeof fakeIoClient>;
    const reply = await client.sendCommand(command);
    await flush();

    const count = (await store.list({ type: EntryType.Redis })).length;
    watcher.stop();
    return { count, reply };
  }

  it('sem opções grava tudo (o default não filtra nada)', async () => {
    const { count } = await recordedCount({}, { name: 'get', args: ['k'] });
    expect(count).toBe(1);
  });

  it('ignoreCommands descarta o comando, case-insensitive', async () => {
    const { count } = await recordedCount(
      { ignoreCommands: ['pttl'] },
      { name: 'PTTL', args: ['k'] },
    );
    expect(count).toBe(0);
  });

  it('ignoreKeys casa como PREFIXO da chave — o caso do rate limiter', async () => {
    const options = { ignoreKeys: ['entretextos:rlflx:'] };
    const dropped = await recordedCount(options, {
      name: 'get',
      args: ['entretextos:rlflx:webhook_google_drive_writing_10.2.5.91'],
    });
    expect(dropped.count).toBe(0);

    // Uma chave que só COMEÇA parecido não pode ser descartada junto.
    const kept = await recordedCount(options, { name: 'get', args: ['entretextos:cache:user'] });
    expect(kept.count).toBe(1);
  });

  it('ignoreKeys aceita RegExp', async () => {
    const { count } = await recordedCount(
      { ignoreKeys: [/:rlflx:/] },
      { name: 'get', args: ['qualquer:rlflx:coisa'] },
    );
    expect(count).toBe(0);
  });

  it('ignoreConnections descarta pela conexão', async () => {
    const { count } = await recordedCount(
      { ignoreConnections: ['Telescope'] },
      { name: 'get', args: ['k'] },
      'telescope',
    );
    expect(count).toBe(0);
  });

  it('sampleRate 0 não grava nada e sampleRate 1 grava tudo', async () => {
    expect((await recordedCount({ sampleRate: 0 }, { name: 'get', args: ['k'] })).count).toBe(0);
    expect((await recordedCount({ sampleRate: 1 }, { name: 'get', args: ['k'] })).count).toBe(1);
  });

  it('sampleRate fora de 0..1 é clampado em vez de derrubar o boot', async () => {
    expect((await recordedCount({ sampleRate: 99 }, { name: 'get', args: ['k'] })).count).toBe(1);
    expect((await recordedCount({ sampleRate: -5 }, { name: 'get', args: ['k'] })).count).toBe(0);
  });

  it('comando filtrado AINDA É EXECUTADO — filtrar é sobre gravar, não sobre rodar', async () => {
    const { count, reply } = await recordedCount(
      { ignoreCommands: ['GET'] },
      { name: 'get', args: ['k'] },
    );
    expect(count).toBe(0);
    expect(reply).toBe('OK');
  });
});
