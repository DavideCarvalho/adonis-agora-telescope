import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  buildLogEntry,
  extractLog,
  interpolate,
  type LogEntryContent,
  type LoggerLike,
  LogsWatcher,
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
      expect((entries[0]!.content as LogEntryContent).message).toBe('keep me');
    });

    it('records a line ONCE when two watchers tap the same logger', async () => {
      // Both `config/telescope.ts` and `config/telescope_watchers.ts` can enable the
      // 'logs' watcher, so two providers can each start one against the SAME logger.
      const logger = fakeLogger();
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        new LogsWatcher().start(logger);
        new LogsWatcher().start(logger);
      } finally {
        console.warn = originalWarn;
      }

      logger.info?.('once please');
      await flush();

      expect(await store.count()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain("'logs' watcher is already tapping");
    });

    it('a second watcher stopping does not untee the first one', async () => {
      const logger = fakeLogger();
      const owner = new LogsWatcher();
      owner.start(logger);
      const teed = logger.info;

      const loser = new LogsWatcher();
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        loser.start(logger);
      } finally {
        console.warn = originalWarn;
      }
      loser.stop();

      // The owner still holds the tap, so logging still records.
      expect(logger.info).toBe(teed);
      logger.info?.('still watched');
      await flush();
      expect(await store.count()).toBe(1);

      owner.stop();
      expect(logger.info).not.toBe(teed);
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

/**
 * Regressão do bug que deixou a tela de Logs vazia por semanas em produção.
 *
 * O provider fazia `container.make('logger') as LoggerLike` — sem `await`. O cast
 * calava o TypeScript, o watcher recebia uma Promise, não achava método de nível
 * nenhum, não tapava nada e retornava EM SILÊNCIO. Zero entries, zero erro, zero
 * aviso: indistinguível de um app que simplesmente não loga.
 *
 * O teste prende o comportamento que torna isso impossível de repetir em silêncio.
 */
describe('LogsWatcher — recebendo algo que não é um logger', () => {
  it('avisa quando não há método de nível pra tapar', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      new LogsWatcher().start(Promise.resolve({}) as never);
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NO logs will be recorded');
  });

  it('o aviso NOMEIA a Promise, que é a causa real', () => {
    // Dizer "sem métodos de nível" manda a pessoa investigar o logger. Dizer
    // "recebi uma Promise" aponta para o `await` que falta.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      new LogsWatcher().start(Promise.resolve({}) as never);
    } finally {
      console.warn = original;
    }
    expect(warnings[0]).toContain('a Promise');
    expect(warnings[0]).toContain('awaited');
  });
});

/**
 * O watcher gravava a string de FORMATO, jogando fora os valores. Um log real de
 * produção chegava assim:
 *
 *   creating query client in %s mode        243x por minuto
 *
 * O `%s` nunca preenchido e o valor (`dual`) descartado. Uma mensagem de log virada
 * em template é a única forma em que ela não serve para nada.
 */
describe('LogsWatcher — interpolação da mensagem', () => {
  it('preenche %s com o valor, como o pino faria', () => {
    expect(interpolate('creating query client in %s mode', ['dual'])).toBe(
      'creating query client in dual mode',
    );
  });

  it('cobre o conjunto do pino', () => {
    expect(interpolate('%d itens', [3])).toBe('3 itens');
    expect(interpolate('%i tentativa', ['2'])).toBe('2 tentativa');
    expect(interpolate('payload %j', [{ a: 1 }])).toBe('payload {"a":1}');
    expect(interpolate('100%% pronto', [])).toBe('100% pronto');
    expect(interpolate('100%% de %s', ['x'])).toBe('100% de x');
  });

  it('placeholder SEM argumento fica como está — não inventa "undefined"', () => {
    // O template é uma mensagem pior; um valor inventado é uma mensagem falsa.
    expect(interpolate('de %s para %s', ['a'])).toBe('de a para %s');
  });

  it('mensagem sem placeholder passa intacta', () => {
    expect(interpolate('nada para preencher', ['ignorado'])).toBe('nada para preencher');
  });

  it('o entry gravado carrega a mensagem já preenchida', () => {
    const built = buildLogEntry('info', [{ userId: 'u1' }, 'salvou %s em %d ms', 'doc', 12]);
    expect((built.content as { message: string }).message).toBe('salvou doc em 12 ms');
  });
});

/**
 * O tee vê a chamada mesmo quando o gate de nível do próprio logger a descarta —
 * então o app não escrevia nada e o telescope guardava tudo. Em produção isso era o
 * `logger.trace()` de dentro do Lucid a 243 entries/min sob LOG_LEVEL=info.
 */
describe('LogsWatcher — respeita o nível do logger', () => {
  /** Um logger cujo gate aceita só `warn` pra cima. */
  function gatedLogger() {
    const calls: string[] = [];
    const make =
      (level: string) =>
      (..._args: unknown[]) =>
        void calls.push(level);
    return {
      trace: make('trace'),
      debug: make('debug'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
      fatal: make('fatal'),
      isLevelEnabled: (level: string) => ['warn', 'error', 'fatal'].includes(level),
    };
  }

  it('não grava o que o logger descartaria', async () => {
    const store = installStore();
    const logger = gatedLogger();
    const watcher = new LogsWatcher();
    watcher.start(logger);

    logger.trace('ruído de infraestrutura');
    logger.info('também abaixo do nível');
    logger.warn('isto o app escreve');
    await flush();

    const entries = await store.list({ type: EntryType.Log });
    expect(entries).toHaveLength(1);
    const only = entries[0];
    if (only === undefined) throw new Error('nenhuma entry gravada');
    expect((only.content as { level: string }).level).toBe('warn');
    watcher.stop();
  });

  it('captureBelowLoggerLevel: true grava abaixo do nível de propósito', async () => {
    const store = installStore();
    const logger = gatedLogger();
    const watcher = new LogsWatcher({ captureBelowLoggerLevel: true });
    watcher.start(logger);

    logger.trace('agora sim');
    await flush();

    expect(await store.count()).toBe(1);
    watcher.stop();
  });

  it('logger SEM isLevelEnabled não é filtrado (comportamento antigo)', async () => {
    const store = installStore();
    const calls: string[] = [];
    const logger = {
      info: (..._a: unknown[]) => void calls.push('info'),
    };
    const watcher = new LogsWatcher();
    watcher.start(logger);

    logger.info('sem gate, grava');
    await flush();

    expect(await store.count()).toBe(1);
    watcher.stop();
  });
});
