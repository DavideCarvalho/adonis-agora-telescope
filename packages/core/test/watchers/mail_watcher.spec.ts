import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import {
  MAIL_SENT_EVENT,
  type MailEntryContent,
  MailWatcher,
  buildMailEntry,
} from '../../src/watchers/index.js';
import {
  clearStore,
  fakeEmitter,
  flush,
  installStore,
  realEmitter,
  throwingStore,
} from './helpers.js';

/** A `mail:sent`-like payload whose `message` exposes `toJSON()` (the Message form). */
function mailSentEvent() {
  return {
    mailerName: 'smtp',
    message: {
      toJSON() {
        return {
          message: {
            from: { address: 'from@example.com', name: 'Sender' },
            to: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
            subject: 'Welcome',
          },
        };
      },
    },
  };
}

describe('MailWatcher', () => {
  afterEach(() => clearStore());

  describe('buildMailEntry', () => {
    it('extracts mailer, from, to and subject from a Message-like payload', () => {
      const input = buildMailEntry(mailSentEvent());
      expect(input.type).toBe(EntryType.Mail);
      const content = input.content as MailEntryContent;
      expect(content.mailer).toBe('smtp');
      expect(content.from).toBe('from@example.com');
      expect(content.to).toEqual(['a@example.com', 'b@example.com']);
      expect(content.subject).toBe('Welcome');
      expect(input.tags).toContain('mailer:smtp');
    });

    it('reads a plain-object envelope and a single string recipient', () => {
      const input = buildMailEntry({
        mailerName: 'log',
        message: { message: { from: 'x@example.com', to: 'y@example.com', subject: 'Hi' } },
      });
      const content = input.content as MailEntryContent;
      expect(content.from).toBe('x@example.com');
      expect(content.to).toEqual(['y@example.com']);
    });

    it('degrades to nulls when fields are missing', () => {
      const input = buildMailEntry({});
      const content = input.content as MailEntryContent;
      expect(content.mailer).toBeNull();
      expect(content.from).toBeNull();
      expect(content.to).toEqual([]);
      expect(content.subject).toBeNull();
    });
  });

  describe('start/stop against the real Adonis emitter', () => {
    let store: ReturnType<typeof installStore>;
    let emitter: ReturnType<typeof realEmitter>;

    beforeEach(() => {
      store = installStore();
      emitter = realEmitter();
    });

    it('records a mail entry on mail:sent', async () => {
      const watcher = new MailWatcher();
      watcher.start(emitter);

      await emitter.emit(MAIL_SENT_EVENT, mailSentEvent());
      await flush();

      const entries = await store.list({ type: EntryType.Mail });
      expect(entries).toHaveLength(1);
      const content = entries[0]?.content as MailEntryContent;
      expect(content.subject).toBe('Welcome');
      expect(content.to).toEqual(['a@example.com', 'b@example.com']);
    });

    it('stops recording after stop()', async () => {
      const watcher = new MailWatcher();
      watcher.start(emitter);
      watcher.stop();

      await emitter.emit(MAIL_SENT_EVENT, mailSentEvent());
      await flush();

      expect(await store.count()).toBe(0);
    });
  });

  it('never throws into the emit when the store rejects', async () => {
    setTelescopeRuntime(throwingStore(), true);
    const emitter = fakeEmitter();
    const watcher = new MailWatcher();
    watcher.start(emitter);

    expect(() => emitter.emit(MAIL_SENT_EVENT, mailSentEvent())).not.toThrow();
    await flush();
  });
});
