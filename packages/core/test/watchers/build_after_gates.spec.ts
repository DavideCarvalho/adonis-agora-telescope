import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTelescopePaused, setTelescopeRuntime } from '../../src/registry.js';
import { SamplingTelescopeStore } from '../../src/sampling/sampling_store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  DB_QUERY_EVENT,
  type LoggerLike,
  LogsWatcher,
  LucidQueryWatcher,
} from '../../src/watchers/index.js';
import { clearStore, fakeEmitter, flush, installStore } from './helpers.js';

const SQL = `select * from "orders" where "id" in (${Array.from({ length: 50 }, (_, i) => i).join(', ')})`;

/** How many times `sql` was lowercased — the first step of templating it into a familyHash. */
function countTemplating(sql: string): () => number {
  const spy = vi.spyOn(String.prototype, 'toLowerCase');
  return () => spy.mock.contexts.filter((context) => String(context) === sql).length;
}

function queryEvent() {
  return { connection: 'primary', sql: SQL, method: 'select', bindings: [], duration: [0, 1e6] };
}

describe('watchers build entries only once they will be recorded', () => {
  afterEach(() => {
    setTelescopePaused(false);
    clearStore();
    vi.restoreAllMocks();
  });

  it('the query watcher does not template the SQL while telescope is paused', () => {
    installStore();
    setTelescopePaused(true);
    const emitter = fakeEmitter();
    new LucidQueryWatcher().start(emitter);
    const templated = countTemplating(SQL);

    emitter.emit(DB_QUERY_EVENT, queryEvent());

    expect(templated()).toBe(0);
  });

  it('the query watcher does not template the SQL of a sampled-out entry', async () => {
    const inner = new InMemoryTelescopeStore();
    setTelescopeRuntime(new SamplingTelescopeStore(inner, { query: 0 }), true);
    const emitter = fakeEmitter();
    new LucidQueryWatcher().start(emitter);
    const templated = countTemplating(SQL);

    emitter.emit(DB_QUERY_EVENT, queryEvent());
    await flush();

    expect(await inner.count()).toBe(0);
    expect(templated()).toBe(0);
  });

  it('the query watcher still groups a kept entry by its SQL template', async () => {
    const store = installStore();
    const emitter = fakeEmitter();
    new LucidQueryWatcher().start(emitter);

    emitter.emit(DB_QUERY_EVENT, queryEvent());
    emitter.emit(DB_QUERY_EVENT, { ...queryEvent(), sql: SQL.replace('49', '7') });
    await flush();

    const [a, b] = await store.list();
    expect(a?.familyHash).toMatch(/^[0-9a-f]{8}$/);
    expect(a?.familyHash).toBe(b?.familyHash);
  });

  it('the logs watcher does not format a message while telescope is paused', () => {
    installStore();
    setTelescopePaused(true);
    const logger = { info: (..._args: unknown[]) => {} };
    new LogsWatcher().start(logger as unknown as LoggerLike);
    const toJSON = vi.fn(() => 'value');

    logger.info('payload %j', { toJSON });

    expect(toJSON).not.toHaveBeenCalled();
  });
});
