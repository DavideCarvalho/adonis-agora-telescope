import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  type JobEntryContent,
  type JobExecuteMessageLike,
  QUEUE_EXECUTE_CHANNEL,
  QueueWatcher,
  buildJobEntry,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

const ASYNC_END = `${QUEUE_EXECUTE_CHANNEL}:asyncEnd`;

/** Publish a job-execute message onto the tracing channel's `:asyncEnd` sub-channel. */
function publish(message: JobExecuteMessageLike): void {
  diagnostics_channel.channel(ASYNC_END).publish(message);
}

describe('QueueWatcher', () => {
  afterEach(() => clearStore());

  describe('buildJobEntry', () => {
    it('shapes a completed job entry with queue, name and duration', () => {
      const input = buildJobEntry({
        job: { id: 'j1', name: 'SendWelcomeEmail', attempts: 1, payload: { to: 'a@b.c' } },
        queue: 'default',
        status: 'completed',
        duration: 42,
      });
      expect(input.type).toBe(EntryType.Job);
      const content = input.content as JobEntryContent;
      expect(content.id).toBe('j1');
      expect(content.name).toBe('SendWelcomeEmail');
      expect(content.queue).toBe('default');
      expect(content.status).toBe('completed');
      expect(content.attempts).toBe(1);
      expect(content.failureReason).toBeNull();
      expect(input.durationMs).toBe(42);
      expect(input.familyHash).toBe('default:SendWelcomeEmail');
      expect(input.tags).toContain('queue');
      expect(input.tags).toContain('queue:default');
      expect(input.tags).toContain('job:SendWelcomeEmail');
      expect(input.tags).toContain('status:completed');
    });

    it('captures a failure reason and tags failed', () => {
      const input = buildJobEntry({
        job: { id: 'j2', name: 'Charge' },
        queue: 'billing',
        status: 'failed',
        error: new Error('card declined'),
      });
      const content = input.content as JobEntryContent;
      expect(content.status).toBe('failed');
      expect(content.failureReason).toBe('card declined');
      expect(input.tags).toContain('failed');
    });

    it('tags slow when duration exceeds the threshold', () => {
      const input = buildJobEntry(
        { job: { name: 'Heavy' }, queue: 'q', status: 'completed', duration: 5000 },
        1000,
      );
      expect(input.tags).toContain('slow');
    });
  });

  describe('start/stop against the diagnostics channel', () => {
    let store: ReturnType<typeof installStore>;

    beforeEach(() => {
      store = installStore();
    });

    it('records a job entry per published execution', async () => {
      const watcher = new QueueWatcher();
      watcher.start();

      publish({ job: { id: 'a', name: 'A' }, queue: 'default', status: 'completed', duration: 5 });
      publish({ job: { id: 'b', name: 'B' }, queue: 'default', status: 'failed', error: 'boom' });
      await flush();

      const entries = await store.list({ type: EntryType.Job });
      expect(entries).toHaveLength(2);
      const statuses = entries.map((e) => (e.content as JobEntryContent).status).sort();
      expect(statuses).toEqual(['completed', 'failed']);

      watcher.stop();
    });

    it('stops recording after stop()', async () => {
      const watcher = new QueueWatcher();
      watcher.start();
      watcher.stop();

      publish({ job: { id: 'a', name: 'A' }, queue: 'default', status: 'completed' });
      await flush();
      expect(await store.count()).toBe(0);
    });
  });

  it('redacts a sensitive field in the stored payload', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    const watcher = new QueueWatcher();
    watcher.start();

    publish({
      job: { id: 'a', name: 'Login', payload: { user: 'x', password: 'hunter2' } },
      queue: 'default',
      status: 'completed',
    });
    await flush();

    const entries = await inner.list({ type: EntryType.Job });
    expect(entries).toHaveLength(1);
    const payload = (entries[0]?.content as JobEntryContent).payload as Record<string, unknown>;
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.user).toBe('x');

    watcher.stop();
  });
});
