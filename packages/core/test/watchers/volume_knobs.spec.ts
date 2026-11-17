import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { detectNPlusOne } from '../../src/query/n_plus_one.js';
import { clampRate, keepByTrace, traceUnit } from '../../src/sampling/trace_sampler.js';
import { isIgnoredRequestPath } from '../../src/telescope_middleware.js';
import { newTraceScope, runInTraceScope } from '../../src/tracing/scope.js';
import {
  CACHE_EVENTS,
  type CacheEntryContent,
  CacheWatcher,
  DB_QUERY_EVENT,
  type DbQueryEventLike,
  LucidQueryWatcher,
  type QueryEntryContent,
  resolveConfig,
} from '../../src/watchers/index.js';
import { clearStore, fakeEmitter, flush, installStore } from './helpers.js';

/** A query that took `ms` milliseconds. */
function query(ms: number, over: Partial<DbQueryEventLike> = {}): DbQueryEventLike {
  return {
    connection: 'primary',
    sql: 'select * from "users" where "id" = ?',
    method: 'select',
    bindings: [1],
    duration: [0, Math.round(ms * 1e6)],
    ...over,
  };
}

/** A trace id whose sampling unit is below (`kept`) or at/above (`dropped`) 0.5. */
function traceIdFor(side: 'kept' | 'dropped'): string {
  for (let i = 0; ; i++) {
    const id = `trace-${i}`;
    const unit = traceUnit(id);
    if (side === 'kept' ? unit < 0.5 : unit >= 0.5) return id;
  }
}

function inTrace<T>(traceId: string, fn: () => T): T {
  const scope = newTraceScope();
  return runInTraceScope({ ...scope, upstreamTraceId: traceId, fallbackTraceId: traceId }, fn);
}

describe('trace sampler', () => {
  it('maps a trace id to a stable unit in [0, 1)', () => {
    const unit = traceUnit('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(unit).toBeLessThan(1);
    expect(traceUnit('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(unit);
  });

  it('keeps or drops a whole trace, and a trace kept at a low rate is kept at a higher one', () => {
    for (let i = 0; i < 200; i++) {
      const id = `t${i}`;
      if (keepByTrace(id, 0.2)) expect(keepByTrace(id, 0.6)).toBe(true);
      expect(keepByTrace(id, 0.3)).toBe(keepByTrace(id, 0.3));
    }
  });

  it('falls back to the random source without a trace', () => {
    expect(keepByTrace(null, 0.5, () => 0.4)).toBe(true);
    expect(keepByTrace(null, 0.5, () => 0.6)).toBe(false);
  });

  it('short-circuits rates 0 and 1, and clamps bad rates', () => {
    expect(keepByTrace('x', 1)).toBe(true);
    expect(keepByTrace('x', 0)).toBe(false);
    expect(clampRate(undefined)).toBe(1);
    expect(clampRate(Number.NaN)).toBe(1);
    expect(clampRate(-1)).toBe(0);
    expect(clampRate(7)).toBe(1);
  });
});

describe('query watcher volume knobs', () => {
  let store: ReturnType<typeof installStore>;
  let emitter: ReturnType<typeof fakeEmitter>;

  beforeEach(() => {
    store = installStore();
    emitter = fakeEmitter();
  });
  afterEach(() => clearStore());

  async function recorded(): Promise<QueryEntryContent[]> {
    await flush();
    return (await store.list({ type: EntryType.Query })).map((e) => e.content as QueryEntryContent);
  }

  it('records every query by default', async () => {
    new LucidQueryWatcher().start(emitter);
    emitter.emit(DB_QUERY_EVENT, query(0.1));
    emitter.emit(DB_QUERY_EVENT, query(30));
    expect(await recorded()).toHaveLength(2);
  });

  it('minMs drops fast queries but keeps slow, failed and unmeasured ones', async () => {
    new LucidQueryWatcher({ minMs: 5, slowMs: 3 }).start(emitter);
    emitter.emit(DB_QUERY_EVENT, query(1, { sql: 'select 1' })); // fast, dropped
    emitter.emit(DB_QUERY_EVENT, query(4, { sql: 'select 2' })); // under minMs but slow (>= slowMs)
    emitter.emit(DB_QUERY_EVENT, query(10, { sql: 'select 3' })); // above minMs
    emitter.emit(DB_QUERY_EVENT, query(1, { sql: 'select 4', error: new Error('boom') })); // failed
    const { duration: _, ...unmeasured } = query(0, { sql: 'select 5' });
    emitter.emit(DB_QUERY_EVENT, unmeasured); // no duration
    const sqls = (await recorded()).map((c) => c.sql).sort();
    expect(sqls).toEqual(['select 2', 'select 3', 'select 4', 'select 5']);
  });

  it('sampleRate 0 still keeps slow and failed queries', async () => {
    new LucidQueryWatcher({ sampleRate: 0, slowMs: 100 }).start(emitter);
    emitter.emit(DB_QUERY_EVENT, query(1, { sql: 'select fast' }));
    emitter.emit(DB_QUERY_EVENT, query(150, { sql: 'select slow' }));
    emitter.emit(DB_QUERY_EVENT, query(1, { sql: 'select failed', error: 'syntax error' }));
    const sqls = (await recorded()).map((c) => c.sql).sort();
    expect(sqls).toEqual(['select failed', 'select slow']);
  });

  it('tags a failed query and records its message', async () => {
    new LucidQueryWatcher().start(emitter);
    emitter.emit(DB_QUERY_EVENT, query(1, { error: new Error('relation "x" does not exist') }));
    await flush();
    const [entry] = await store.list({ type: EntryType.Query });
    if (entry === undefined) throw new Error('no query entry recorded');
    expect(entry.tags).toContain('failed');
    expect((entry.content as QueryEntryContent).error).toBe('relation "x" does not exist');
  });

  it('samples per trace: a kept request keeps all of its queries, so N+1 stays visible', async () => {
    new LucidQueryWatcher({ sampleRate: 0.5 }).start(emitter);
    const kept = traceIdFor('kept');
    const dropped = traceIdFor('dropped');
    for (const traceId of [kept, dropped]) {
      inTrace(traceId, () => {
        for (let i = 0; i < 5; i++) emitter.emit(DB_QUERY_EVENT, query(1, { sql: 'select ?' }));
      });
    }
    await flush();
    const entries = await store.list({ type: EntryType.Query });
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((e) => e.traceId))).toEqual(new Set([kept]));
    expect(detectNPlusOne(entries, 3)).toHaveLength(1);
  });

  it('is wired from config/telescope_watchers.ts', () => {
    const config = resolveConfig({ query: { minMs: 2, sampleRate: 1.5 } });
    expect(config.query.minMs).toBe(2);
    expect(config.query.sampleRate).toBe(1);
    expect(resolveConfig().query).toMatchObject({ minMs: 0, sampleRate: 1 });
  });
});

describe('cache watcher volume knobs', () => {
  let store: ReturnType<typeof installStore>;
  let emitter: ReturnType<typeof fakeEmitter>;

  beforeEach(() => {
    store = installStore();
    emitter = fakeEmitter();
  });
  afterEach(() => clearStore());

  async function operations(): Promise<string[]> {
    await flush();
    return (await store.list({ type: EntryType.Cache }))
      .map((e) => {
        const c = e.content as CacheEntryContent;
        return `${c.operation}:${c.key}`;
      })
      .sort();
  }

  it('hitSampleRate samples hits only; misses, writes, deletes and clears are kept', async () => {
    new CacheWatcher(CACHE_EVENTS, { hitSampleRate: 0 }).start(emitter);
    emitter.emit('cache:hit', { key: 'a', store: 'redis' });
    emitter.emit('cache:miss', { key: 'b', store: 'redis' });
    emitter.emit('cache:written', { key: 'c', store: 'redis' });
    emitter.emit('cache:deleted', { key: 'd', store: 'redis' });
    emitter.emit('cache:cleared', { store: 'redis' });
    expect(await operations()).toEqual(['clear:null', 'delete:d', 'miss:b', 'write:c']);
  });

  it('hitSampleRate decides per trace', async () => {
    new CacheWatcher(CACHE_EVENTS, { hitSampleRate: 0.5 }).start(emitter);
    inTrace(traceIdFor('kept'), () => emitter.emit('cache:hit', { key: 'kept' }));
    inTrace(traceIdFor('dropped'), () => emitter.emit('cache:hit', { key: 'dropped' }));
    expect(await operations()).toEqual(['hit:kept']);
  });

  it('ignoreStores drops every operation on those stores (case-insensitive)', async () => {
    new CacheWatcher(CACHE_EVENTS, { ignoreStores: ['Memory'] }).start(emitter);
    emitter.emit('cache:miss', { key: 'a', store: 'memory' });
    emitter.emit('cache:miss', { key: 'b', store: 'redis' });
    expect(await operations()).toEqual(['miss:b']);
  });

  it('ignoreKeys matches strings as prefixes and RegExps as-is', async () => {
    new CacheWatcher(CACHE_EVENTS, { ignoreKeys: ['session:', /^rate-limit:/g] }).start(emitter);
    emitter.emit('cache:written', { key: 'session:abc' });
    emitter.emit('cache:written', { key: 'rate-limit:1.2.3.4' });
    emitter.emit('cache:written', { key: 'rate-limit:5.6.7.8' });
    emitter.emit('cache:written', { key: 'user:1' });
    expect(await operations()).toEqual(['write:user:1']);
  });

  it('is wired from config/telescope_watchers.ts', () => {
    const config = resolveConfig({ cache: { hitSampleRate: 0.1, ignoreStores: ['memory'] } });
    expect(config.cache).toEqual({ hitSampleRate: 0.1, ignoreStores: ['memory'], ignoreKeys: [] });
    expect(resolveConfig().cache).toEqual({ hitSampleRate: 1, ignoreStores: [], ignoreKeys: [] });
  });
});

describe('ignoreRequestPaths', () => {
  it('matches strings as segment-boundary prefixes, ignoring the query string', () => {
    expect(isIgnoredRequestPath('/assets/app.js?v=1', ['/assets'])).toBe(true);
    expect(isIgnoredRequestPath('/assets', ['/assets'])).toBe(true);
    expect(isIgnoredRequestPath('/assets-old/x', ['/assets'])).toBe(false);
    expect(isIgnoredRequestPath('/users', [])).toBe(false);
  });

  it('skips empty string patterns instead of ignoring every path', () => {
    expect(isIgnoredRequestPath('/users', [''])).toBe(false);
    expect(isIgnoredRequestPath('/users', ['  ', '/assets'])).toBe(false);
    expect(isIgnoredRequestPath('/assets/x', ['', '/assets'])).toBe(true);
  });

  it('tests RegExps against the path', () => {
    const patterns = [/\.(png|css)$/g];
    expect(isIgnoredRequestPath('/img/logo.png', patterns)).toBe(true);
    expect(isIgnoredRequestPath('/img/logo.png', patterns)).toBe(true);
    expect(isIgnoredRequestPath('/page?file=a.png', patterns)).toBe(false);
  });
});
