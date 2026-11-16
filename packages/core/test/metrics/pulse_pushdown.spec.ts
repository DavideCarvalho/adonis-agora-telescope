import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import { PulseService } from '../../src/metrics/pulse.js';
import type { TelescopeStore } from '../../src/store.js';
import { type LucidDatabaseLike, LucidTelescopeStore } from '../../src/stores/lucid.js';
import { scopedStore } from '../../src/tenancy_store.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';

/**
 * Pulse answers from SQL aggregates when the store has them, and from a scan of the window
 * otherwise. The two must give the same summary — these tests run both over one fixture, on
 * SQLite always and on Postgres / MySQL when `TELESCOPE_TEST_PG_URL` / `TELESCOPE_TEST_MYSQL_URL`
 * are set (CI sets both).
 */

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const HOUR = 3_600_000;

/** The same store without the optional reads: a third-party store written before them. */
function legacy(store: TelescopeStore): TelescopeStore {
  return {
    record: (input) => store.record(input),
    get: (id) => store.get(id),
    list: (query) => store.list(query),
    count: () => store.count(),
    prune: (olderThan, keepLast) => store.prune(olderThan, keepLast),
    clear: () => store.clear(),
  };
}

async function seed(store: LucidTelescopeStore): Promise<void> {
  let at = NOW - 50 * 60_000;
  const next = () => {
    at += 1_000;
    return new Date(at);
  };
  const record = (input: Parameters<LucidTelescopeStore['record']>[0]) =>
    store.record({ ...input, createdAt: input.createdAt ?? next() });

  // Outside the window: must not count anywhere.
  await record({
    type: 'request',
    content: { method: 'GET', url: '/old', status: 500 },
    durationMs: 99_999,
    tags: ['app:a'],
    createdAt: new Date(NOW - 2 * HOUR),
  });

  for (let t = 0; t < 12; t++) {
    const traceId = `trace-${String(t).padStart(2, '0')}`;
    const app = t % 3 === 0 ? 'app:b' : 'app:a';
    await record({
      type: 'request',
      content: {
        method: t % 4 === 0 ? 'POST' : 'GET',
        url: `/orders/${t % 3}`,
        status: [200, 201, 302, 404, 500, null][t % 6] ?? null,
        body: { secret: 'x'.repeat(50) },
      },
      // Integer durations with ties, some past the slow-route threshold.
      durationMs: [1_500, 1_500, 30, 2_200, 1_500, 80][t % 6] ?? null,
      tags: [app, `user:u${t % 4}`, ...(t % 5 === 0 ? ['user:extra'] : [])],
      traceId,
    });
    // N+1: equal counts across several traces (tie-break by recency, then id).
    const loops = t % 2 === 0 ? 5 : t % 3 === 0 ? 7 : 3;
    for (let q = 0; q < loops; q++) {
      await record({
        type: 'query',
        familyHash: 'orders-by-user',
        content: { sql: `select * from orders where user_id = ${t * 10 + q}` },
        durationMs: q % 2 === 0 ? 4 : null,
        traceId,
        tags: [app],
      });
    }
    await record({
      type: 'query',
      familyHash: `report-${t % 2}`,
      content: { sql: `select sum(total) from orders /* ${t} */` },
      durationMs: 2_200,
      traceId,
      tags: [app],
    });
    await record({
      type: 'redis',
      content: { command: 'GET', args: ['k'] },
      durationMs: 2_200,
      tags: [app],
    });
    await record({
      type: 'cache',
      content: {
        operation: ['hit', 'miss', 'write', 'delete'][t % 4] ?? null,
        key: t % 5 === 0 ? null : `k${t % 3}`,
      },
      tags: [app],
    });
    await record({
      type: 'http-client',
      familyHash: `GET api-${t % 2}`,
      content: { method: 'GET', url: `https://api/${t % 2}` },
      durationMs: 900 + t * 50,
      tags: [app],
    });
    await record({
      type: 'job',
      familyHash: `job-${t % 3}`,
      content: { queue: 'q', name: `j${t % 3}` },
      durationMs: 10 + t,
      tags: [app],
    });
  }
  await record({
    type: 'exception',
    familyHash: 'boom',
    content: { name: 'TypeError', message: 'boom', stack: 'at …' },
    tags: ['app:a'],
  });
  await record({
    type: 'exception',
    familyHash: null,
    content: { name: 'RangeError', message: 'bad' },
    tags: ['app:b'],
  });
  await record({
    type: 'client_exception',
    familyHash: 'ce',
    content: { name: 'Error', message: 'front' },
    tags: ['app:a'],
  });
  await record({ type: 'log', content: { message: 'no duration' }, tags: ['app:a'] });
  await store.flush();
}

interface Target {
  name: string;
  open(): Promise<{ store: LucidTelescopeStore; close(): Promise<void> }>;
}

const sqlite: Target = {
  name: 'sqlite',
  async open() {
    const harness: TestHarness = await makeHarness();
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
      // Its own schema (a MySQL database), dropped afterwards: nothing lands in the
      // connection's default one, which other suites share.
      const schema = `pulse_pushdown_${randomBytes(4).toString('hex')}`;
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
  sqlite,
  server('postgres', 'pg', process.env.TELESCOPE_TEST_PG_URL),
  server('mysql', 'mysql2', process.env.TELESCOPE_TEST_MYSQL_URL),
].filter((t): t is Target => t !== null);

for (const target of targets) {
  describe(`pulse SQL fast path matches the scan (${target.name})`, () => {
    let store: LucidTelescopeStore;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ store, close } = await target.open());
      await seed(store);
    });
    afterAll(async () => {
      await close();
    });
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('the store offers the fast paths', () => {
      expect(typeof store.listSlowest).toBe('function');
      expect(typeof store.countTraceRepeats).toBe('function');
      expect(store.honorsTagGroups).toBe(true);
    });

    it('every card is identical on both paths', async () => {
      const fast = await new PulseService(store).getHealth({ windowMs: HOUR });
      const slow = await new PulseService(legacy(store)).getHealth({ windowMs: HOUR });
      expect(fast).toEqual(slow);
      // The fixture exercises every card.
      expect(fast.truncated).toBe(false);
      expect(fast.counts.request).toBe(12);
      expect(fast.nPlusOne[0]?.familyHash).toBe('orders-by-user');
      expect(fast.slowest).toHaveLength(5);
      expect(fast.slowRoutes.length).toBeGreaterThan(0);
      expect(fast.slowOutgoing.length).toBeGreaterThan(0);
      expect(fast.slowJobs.length).toBeGreaterThan(0);
      expect(fast.topExceptions).toHaveLength(3);
      expect(fast.loadByUser.length).toBeGreaterThan(0);
      expect(fast.cache?.topKeys.length).toBeGreaterThan(0);
      expect(fast.requests.status['5xx']).toBe(2);
    });

    it('a smaller topN and a subset of cards stay identical', async () => {
      const options = { cards: ['requests', 'nPlusOne', 'slowest'] as const, topN: 2 };
      const fast = await new PulseService(store, {
        ...options,
        cards: [...options.cards],
      }).getHealth({ windowMs: HOUR });
      const slow = await new PulseService(legacy(store), {
        ...options,
        cards: [...options.cards],
      }).getHealth({ windowMs: HOUR });
      expect(fast).toEqual(slow);
      expect(fast.cache).toBeUndefined();
    });

    it('a view narrowed to one app is identical on both paths and keeps the fast paths', async () => {
      const scopedFast = scopedStore(store, null, ['app:a']);
      const scopedSlow = scopedStore(legacy(store), null, ['app:a']);
      expect(typeof scopedFast.countTraceRepeats).toBe('function');
      expect(scopedSlow.countTraceRepeats).toBeUndefined();

      const fast = await new PulseService(scopedFast).getHealth({ windowMs: HOUR });
      const slow = await new PulseService(scopedSlow).getHealth({ windowMs: HOUR });
      expect(fast).toEqual(slow);
      expect(fast.counts.request).toBe(8);

      const tsFast = await new MetricsService(scopedFast).getTimeseries({
        windowMs: HOUR,
        buckets: 30,
      });
      const tsSlow = await new MetricsService(scopedSlow).getTimeseries({
        windowMs: HOUR,
        buckets: 30,
      });
      expect(tsFast).toEqual(tsSlow);
    });

    it('tenant AND app groups narrow the aggregates like the scan', async () => {
      const fast = scopedStore(store, ['app:a', 'app:b'], ['app:b']);
      const slow = scopedStore(legacy(store), ['app:a', 'app:b'], ['app:b']);
      expect(await new PulseService(fast).getHealth({ windowMs: HOUR })).toEqual(
        await new PulseService(slow).getHealth({ windowMs: HOUR }),
      );
      const nothing = scopedStore(store, [], null);
      expect((await new PulseService(nothing).getHealth({ windowMs: HOUR })).scanned).toBe(0);
    });

    it('contentFields returns only those fields, absent ones left out', async () => {
      const [request] = await store.list({
        type: 'request',
        size: 1,
        contentFields: ['status', 'url', 'missing'],
      });
      // The newest request (t = 11) has a JSON `null` status: kept as null, not dropped.
      expect(request?.content).toEqual({ status: null, url: '/orders/2' });
      const [, older] = await store.list({ type: 'request', size: 2, contentFields: ['status'] });
      expect(older?.content).toEqual({ status: 500 });
      const [cache] = await store.list({
        type: 'cache',
        size: 1,
        contentFields: ['operation', 'key'],
      });
      expect(cache?.content).toEqual({ operation: 'delete', key: 'k2' });
      // A field name that is not a plain identifier: the hint is ignored, whole content back.
      const [whole] = await store.list({ type: 'request', size: 1, contentFields: ["x') --"] });
      expect(whole?.content).toMatchObject({ method: 'GET', body: { secret: expect.any(String) } });
    });
  });
}
