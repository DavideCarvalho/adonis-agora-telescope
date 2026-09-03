import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  buildJobEntry,
  type JobEntryContent,
  type JobExecuteMessageLike,
  QUEUE_EXECUTE_CHANNEL,
  QueueWatcher,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/**
 * O MESMO tracing channel que o `@boringnode/queue` usa. Publicar por ele, e não por um nome
 * montado à mão, é o ponto — foi exatamente essa montagem à mão que deixou o bug passar.
 *
 * A versão anterior deste arquivo fazia `channel(`${QUEUE_EXECUTE_CHANNEL}:asyncEnd`)`, o mesmo
 * nome errado que o watcher assinava. Teste e código cometiam o mesmo engano, então o teste
 * passava com o watcher surdo em produção (`type=job` em ZERO com o worker executando jobs). Um
 * teste que reproduz a suposição do código não testa a suposição.
 */
const executeChannel = diagnostics_channel.tracingChannel(QUEUE_EXECUTE_CHANNEL);

/** Publish a job-execute message onto the tracing channel's `asyncEnd` sub-channel. */
function publish(message: JobExecuteMessageLike): void {
  diagnostics_channel.channel(executeChannel.asyncEnd.name).publish(message);
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
    const payload = (entries[0]!.content as JobEntryContent).payload as Record<string, unknown>;
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.user).toBe('x');

    watcher.stop();
  });
});

describe('QueueWatcher — o canal que o engine realmente publica', () => {
  afterEach(() => clearStore());

  it('grava quando o engine usa tracePromise, que é como o @boringnode/queue executa', async () => {
    // Este é o teste que teria pego o bug. Ele não sabe o nome de sub-canal nenhum: usa o
    // `tracingChannel` como o engine usa, e deixa o Node decidir os nomes.
    const store = installStore();
    const watcher = new QueueWatcher();
    watcher.start();

    const message: JobExecuteMessageLike = {
      job: { id: 'j1', name: 'SendWelcomeEmail', attempts: 1 },
      queue: 'default',
    };
    await executeChannel.tracePromise(async () => {
      message.status = 'completed';
      message.duration = 7;
      return 'ok';
    }, message);
    await flush();

    const entries = await store.list({ type: EntryType.Job });
    expect(entries).toHaveLength(1);
    expect((entries[0]?.content as JobEntryContent | undefined)?.name).toBe('SendWelcomeEmail');

    watcher.stop();
  });

  it('para de gravar depois do stop()', async () => {
    const store = installStore();
    const watcher = new QueueWatcher();
    watcher.start();
    watcher.stop();

    const message: JobExecuteMessageLike = { job: { id: 'j2', name: 'B' }, queue: 'default' };
    await executeChannel.tracePromise(async () => 'ok', message);
    await flush();

    expect(await store.list({ type: EntryType.Job })).toHaveLength(0);
  });
});
