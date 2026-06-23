import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  type LogEntryContent,
  type LoggerLike,
  LogsWatcher,
  buildLogEntry,
  extractLog,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A minimal pino-style logger double recording the calls it received. */
function fakeLogger(): LoggerLike & { calls: Array<{ level: string; args: unknown[] }> } {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const make =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  return {
    calls,
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
  };
}

describe('LogsWatcher', () => {
  describe('extractLog', () => {
    it('reads a bare message', () => {
      expect(extractLog(['hello'])).toEqual({ message: 'hello', context: null });
    });
    it('reads (mergingObject, message)', () => {
      expect(extractLog([{ userId: 7 }, 'done'])).toEqual({
        message: 'done',
        context: { userId: 7 },
      });
    });
  });

  describe('buildLogEntry', () => {
    it('shapes a log entry with level + message + tags', () => {
      const input = buildLogEntry('error', ['boom']);
      expect(input.type).toBe(EntryType.Log);
      const content = input.content as LogEntryContent;
      expect(content.level).toBe('error');
      expect(content.message).toBe('boom');
      expect(input.familyHash).toBe('log:error');
      expect(input.tags).toContain('log');
      expect(input.tags).toContain('log:error');
    });
  });

  describe('teeing a logger instance', () => {
    let store: ReturnType<typeof installStore>;

    beforeEach(() => {
      store = installStore();
    });
    afterEach(() => clearStore());

    it('records a Log entry with level + message, and still calls the original', async () => {
      const logger = fakeLogger();
      const watcher = new LogsWatcher();
      watcher.start(logger);

      logger.info?.('hello world');
      await flush();

      // Original still ran.
      expect(logger.calls).toEqual([{ level: 'info', args: ['hello world'] }]);
      const entries = await store.list({ type: EntryType.Log });
      expect(entries).toHaveLength(1);
      const content = entries[0]?.content as LogEntryContent;
      expect(content.level).toBe('info');
      expect(content.message).toBe('hello world');
    });

    it('captures structured fields from a merging object', async () => {
      const logger = fakeLogger();
      new LogsWatcher().start(logger);

      logger.warn?.({ orderId: 42 }, 'late');
      await flush();

      const content = (await store.list({ type: EntryType.Log }))[0]?.content as LogEntryContent;
      expect(content.message).toBe('late');
      expect(content.context).toEqual({ orderId: 42 });
    });

    it('respects minLevel', async () => {
      const logger = fakeLogger();
      new LogsWatcher({ minLevel: 'warn' }).start(logger);

      logger.info?.('skip me');
      logger.error?.('keep me');
      await flush();

      const entries = await store.list({ type: EntryType.Log });
      expect(entries).toHaveLength(1);
      expect((entries[0]?.content as LogEntryContent).message).toBe('keep me');
    });

    it('restores the original methods on stop()', async () => {
      const logger = fakeLogger();
      const original = logger.info;
      const watcher = new LogsWatcher();
      watcher.start(logger);
      expect(logger.info).not.toBe(original);

      watcher.stop();
      expect(logger.info).toBe(original);

      logger.info?.('after stop');
      await flush();
      expect(await store.count()).toBe(0);
    });
  });

  it('respects the config toggle: a not-started watcher records nothing', async () => {
    const store = installStore();
    const logger = fakeLogger();
    // Watcher constructed but never started — simulates 'logs' omitted from config.
    new LogsWatcher();
    logger.info?.('untracked');
    await flush();
    expect(await store.count()).toBe(0);
    clearStore();
  });

  it('redacts sensitive fields in structured context', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    const logger = fakeLogger();
    new LogsWatcher().start(logger);

    logger.info?.({ password: 'hunter2', user: 'davi' }, 'login');
    await flush();

    const content = (await inner.list({ type: EntryType.Log }))[0]?.content as LogEntryContent;
    expect(content.context?.password).toBe('[REDACTED]');
    expect(content.context?.user).toBe('davi');
    clearStore();
  });
});
