import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import type { TelescopeStore, TraceIdRow } from '../../src/store.js';
import { type LucidDatabaseLike, LucidTelescopeStore } from '../../src/stores/lucid.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { scopedStore } from '../../src/tenancy_store.js';
import { makeHarness } from '../lucid_helpers.js';

/**
 * The traces list pages by keyset (`pageTraceIds`): a walk of the entries newest-first instead
 * of a `GROUP BY trace_id` over the table. These tests pin its order (most recently active first,
 * then the larger trace id), that walking every page by cursor shows each trace once, app scoping,
 * and that the answer matches the scan the old path did. SQLite and the in-memory store always;
 * Postgres / MySQL when `TELESCOPE_TEST_PG_URL` / `TELESCOPE_TEST_MYSQL_URL` are set.
 */

const T0 = Date.UTC(2026, 10, 17, 12, 0);

interface Seeded {
  traceId: string;
  app: string;
  /** createdAt (ms) of each entry of the trace. */
  at: number[];
}

/**
 * 45 traces of 6 entries (one request each, the request recorded last), interleaved in time so
 * a trace's entries are not adjacent, plus entries outside any trace. Groups of traces end on the
 * same millisecond so page boundaries fall on ties. Over 200 rows: the walk needs several batches.
 */
function fixture(): Seeded[] {
  const traces: Seeded[] = [];
  for (let t = 0; t < 45; t++) {
    const start = T0 + t * 400;
    // Every third trace ends on the same millisecond as the one before it.
    const end = t % 3 === 2 ? T0 + (t - 1) * 400 + 900 : start + 900;
    const at = [0, 1, 2, 3, 4].map((j) => start + j * 150);
    at.push(end);
    traces.push({
      traceId: `trace-${String((t * 17) % 45).padStart(2, '0')}`,
      app: t % 4 === 0 ? 'app:b' : 'app:a',
      at,
    });
  }
  return traces;
}

async function seed(store: TelescopeStore & { flush?: () => Promise<void> }, traces: Seeded[]) {
  for (const trace of traces) {
    for (const [j, at] of trace.at.entries()) {
      const request = j === trace.at.length - 1;
      await store.record({
        type: request ? 'request' : 'query',
        content: request ? { method: 'GET', url: `/${trace.traceId}`, body: 'x'.repeat(200) } : {},
        durationMs: 5,
        tags: [trace.app],
        traceId: trace.traceId,
        createdAt: new Date(at),
      });
    }
    await store.record({
      type: 'log',
      content: { message: 'no trace' },
      tags: [trace.app],
      traceId: null,
      createdAt: new Date(trace.at[2]! + 1),
    });
  }
  await store.flush?.();
}

/** The list order the keyset must reproduce, optionally only counting `app`'s entries. */
function reference(traces: Seeded[], app?: string): TraceIdRow[] {
  return traces
    .filter((trace) => app === undefined || trace.app === app)
    .map((trace) => ({ traceId: trace.traceId, lastAt: new Date(Math.max(...trace.at)) }))
    .sort(
      (a, b) =>
        b.lastAt.getTime() - a.lastAt.getTime() ||
        (a.traceId < b.traceId ? 1 : a.traceId > b.traceId ? -1 : 0),
    );
}

/** Every page, following each page's cursor. */
async function walk(metrics: MetricsService, size: number) {
  const pages: string[][] = [];
  let cursor: TraceIdRow | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await metrics.getTracesSlice({ offset: 0, size, ...(cursor ? { cursor } : {}) });
    pages.push(page.rows.map((row) => row.traceId));
    if (!page.hasMore) return pages;
    cursor = page.last ?? undefined;
  }
  throw new Error('the walk never ended');
}

interface Target {
  name: string;
  open(): Promise<{ store: TelescopeStore; close(): Promise<void> }>;
}

const memory: Target = {
  name: 'memory',
  async open() {
    return { store: new InMemoryTelescopeStore({ maxEntries: 10_000 }), close: async () => {} };
  },
};

const sqlite: Target = {
  name: 'sqlite',
  async open() {
    const harness = await makeHarness();
    const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    return { store, close: () => harness.cleanup() };
  },
};

function server(name: string, client: 'pg' | 'mysql2', url: string | undefined): Target | null {
  if (!url) return null;
  return {
    name,
    async open() {
      const db = new Database(
        { connection: 'main', connections: { main: { client, connection: url } as never } },
        new Logger({ enabled: false }),
        new Emitter(undefined as any),
      );
      // Its own schema, dropped afterwards (see pulse_pushdown.spec.ts).
      const schema = `traces_keyset_${randomBytes(4).toString('hex')}`;
      const lucid = db.connection('main') as unknown as LucidDatabaseLike;
      const store = new LucidTelescopeStore(lucid, { schema, autoCreateTable: true });
      return {
        store,
        close: async () => {
          await db
            .connection('main')
            .rawQuery(
              client === 'mysql2'
                ? `DROP DATABASE IF EXISTS \`${schema}\``
                : `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
            );
          await db.manager.closeAll();
        },
      };
    },
  };
}

const targets = [
  memory,
  sqlite,
  server('postgres', 'pg', process.env.TELESCOPE_TEST_PG_URL),
  server('mysql', 'mysql2', process.env.TELESCOPE_TEST_MYSQL_URL),
].filter((t): t is Target => t !== null);

for (const target of targets) {
  describe(`traces list by keyset (${target.name})`, () => {
    const traces = fixture();
    let store: TelescopeStore;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ store, close } = await target.open());
      await seed(store, traces);
    });
    afterAll(async () => {
      await close();
    });

    it('offers the keyset read', () => {
      expect(typeof store.pageTraceIds).toBe('function');
    });

    it('orders most recently active first, then by the larger trace id', async () => {
      const expected = reference(traces);
      expect(await store.pageTraceIds!({ size: 100 })).toEqual(expected);
    });

    it.each([1, 2, 4, 7, 50])('walks every trace once by cursor, %i per page', async (size) => {
      const pages = await walk(new MetricsService(store), size);
      const expected = reference(traces).map((row) => row.traceId);
      expect(pages.flat()).toEqual(expected);
      expect(pages.slice(0, -1).every((page) => page.length === size)).toBe(true);
    });

    it('an offset reads the same page as the cursor walk', async () => {
      const metrics = new MetricsService(store);
      const expected = reference(traces).map((row) => row.traceId);
      const page = await metrics.getTracesSlice({ offset: 10, size: 5 });
      expect(page.rows.map((row) => row.traceId)).toEqual(expected.slice(10, 15));
      expect(page.hasMore).toBe(true);
      expect(page.last?.traceId).toBe(expected[14]);
      const tail = await metrics.getTracesSlice({ offset: 40, size: 10 });
      expect(tail.rows).toHaveLength(5);
      expect(tail.hasMore).toBe(false);
    });

    it('summarizes each trace of the page from its own entries', async () => {
      const [first] = (await new MetricsService(store).getTracesSlice({ offset: 0, size: 1 })).rows;
      const expected = reference(traces)[0]!;
      expect(first).toMatchObject({
        traceId: expected.traceId,
        entryCount: 6,
        types: ['query', 'request'],
        lastAt: expected.lastAt,
        totalDurationMs: 30,
        rootLabel: `GET /${expected.traceId}`,
      });
    });

    it('matches the scan-and-group path of a store without the fast paths', async () => {
      const legacy: TelescopeStore = {
        record: (input) => store.record(input),
        get: (id) => store.get(id),
        list: (query) => store.list(query),
        count: () => store.count(),
        prune: (olderThan, keepLast) => store.prune(olderThan, keepLast),
        clear: () => store.clear(),
      };
      const fast = await new MetricsService(store).getTracesSlice({ offset: 0, size: 45 });
      const slow = await new MetricsService(legacy).getTracesSlice({ offset: 0, size: 45 });
      const byId = (rows: { traceId: string }[]) =>
        [...rows].sort((a, b) => a.traceId.localeCompare(b.traceId));
      expect(byId(fast.rows)).toEqual(byId(slow.rows));
    });

    it('stops at a cursor past the oldest trace', async () => {
      const oldest = reference(traces).at(-1)!;
      expect(await store.pageTraceIds!({ size: 5, cursor: oldest })).toEqual([]);
    });
  });
}

for (const target of targets.filter((t) => t.name !== 'memory')) {
  describe(`traces list scoped to an app (${target.name})`, () => {
    const traces = fixture();
    let store: TelescopeStore;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ store, close } = await target.open());
      await seed(store, traces);
    });
    afterAll(async () => {
      await close();
    });

    it('pages only the traces of the app in view, by keyset', async () => {
      const scoped = scopedStore(store, null, ['app:b']);
      expect(typeof scoped.pageTraceIds).toBe('function');
      const pages = await walk(new MetricsService(scoped), 3);
      expect(pages.flat()).toEqual(reference(traces, 'app:b').map((row) => row.traceId));
    });

    it('an app with no entries has no traces', async () => {
      const scoped = scopedStore(store, null, ['app:none']);
      expect(await new MetricsService(scoped).getTracesSlice({ offset: 0, size: 5 })).toEqual({
        rows: [],
        hasMore: false,
        last: null,
      });
    });
  });
}

describe('traces list while traces keep arriving (sqlite)', () => {
  it('does not show again a trace that became active after its page was read', async () => {
    const harness = await makeHarness();
    try {
      const store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
      const at = (s: number) => new Date(T0 + s * 1000);
      for (let i = 0; i < 6; i++) {
        await store.record({ type: 'request', content: {}, traceId: `t${i}`, createdAt: at(i) });
      }
      await store.flush();
      const metrics = new MetricsService(store);

      const first = await metrics.getTracesSlice({ offset: 0, size: 2 });
      expect(first.rows.map((row) => row.traceId)).toEqual(['t5', 't4']);

      // t4 (on page one) and t1 (not read yet) get a new entry; a brand new trace starts.
      await store.record({ type: 'query', content: {}, traceId: 't4', createdAt: at(10) });
      await store.record({ type: 'query', content: {}, traceId: 't1', createdAt: at(11) });
      await store.record({ type: 'request', content: {}, traceId: 't9', createdAt: at(12) });
      await store.flush();

      const rest = await metrics.getTracesSlice({ offset: 2, size: 10, cursor: first.last! });
      // Neither repeated nor jumped back to: t4 and t1 are now at the top of page one.
      expect(rest.rows.map((row) => row.traceId)).toEqual(['t3', 't2', 't0']);
      expect(rest.hasMore).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
