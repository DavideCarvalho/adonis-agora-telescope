import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import { PULSE_CARDS, PulseService, summarizePulse } from '../../src/metrics/pulse.js';
import { summarizeStats } from '../../src/metrics/stats.js';
import { LucidTelescopeStore } from '../../src/stores/lucid.js';
import { makeHarness, type TestHarness } from '../lucid_helpers.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const HOUR = 3_600_000;

/** A window with every kind of entry the pulse cards read: requests, an N+1 loop of
 *  queries, slow queries, cache operations and exceptions. */
async function seed(store: LucidTelescopeStore): Promise<void> {
  let at = NOW - 30 * 60_000;
  const tick = () => {
    at += 1_000;
    vi.setSystemTime(at);
  };
  for (let r = 0; r < 4; r++) {
    const traceId = `trace-${r}`;
    tick();
    await store.record({
      type: 'request',
      content: { method: 'GET', url: `/orders/${r % 2}`, status: r === 3 ? 500 : 200 },
      durationMs: 1_200 + r * 10,
      tags: [`user:${r % 2}`],
      traceId,
    });
    for (let q = 0; q < 6; q++) {
      tick();
      await store.record({
        type: 'query',
        familyHash: 'orders-by-user',
        content: { sql: `select * from orders where user_id = ${r * 10 + q}` },
        durationMs: 3 + q,
        traceId,
      });
    }
    tick();
    await store.record({
      type: 'query',
      familyHash: `report-${r}`,
      content: { sql: `select sum(total) from orders /* ${r} */` },
      durationMs: 2_000 + r,
      traceId,
    });
    tick();
    await store.record({ type: 'cache', content: { operation: r % 2 ? 'hit' : 'miss', key: 'k' } });
  }
  tick();
  await store.record({
    type: 'exception',
    familyHash: 'boom',
    content: { name: 'TypeError', message: 'boom' },
  });
}

describe('dashboard aggregates over a content-less scan', () => {
  let harness: TestHarness;
  let store: LucidTelescopeStore;
  let returnedQueriesWithContent: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    harness = await makeHarness();
    store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
    await seed(store);
    vi.setSystemTime(NOW);
    returnedQueriesWithContent = 0;
    const list = store.list.bind(store);
    vi.spyOn(store, 'list').mockImplementation(async (query) => {
      const entries = await list(query);
      for (const entry of entries) {
        if (entry.type === 'query' && entry.content !== null) returnedQueriesWithContent += 1;
      }
      return entries;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await harness.cleanup();
  });

  /** Every entry in the pulse window, with content: what the summary is defined over. */
  async function windowEntries(): Promise<Entry[]> {
    const entries = await store.list({ after: new Date(NOW - HOUR), size: 50_000 });
    returnedQueriesWithContent = 0;
    return entries;
  }

  it('pulse matches the summary over full entries, reading query content only for the rows it labels', async () => {
    const expected = summarizePulse(await windowEntries(), new Date(NOW - HOUR), new Date(NOW), {
      topN: 5,
      buckets: 60,
      slowMs: 100,
      slowRouteMs: 1000,
      hotspotMinCount: 1,
      nPlusOneThreshold: 5,
      cards: new Set(PULSE_CARDS),
    });
    const get = vi.spyOn(store, 'get');

    const actual = await new PulseService(store).getHealth({ windowMs: HOUR });

    expect(actual).toEqual(expected);
    expect(actual.nPlusOne[0]?.sql).toBe('select * from orders where user_id = 35');
    expect(actual.slowest[0]?.label).toBe('select sum(total) from orders /* 3 */');
    // 33 query entries in the window, none of them shipped with content by a list.
    expect(returnedQueriesWithContent).toBe(0);
    expect(get.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('query stats match the summary over full entries, labelling families by id', async () => {
    const entries = (await windowEntries()).filter((entry) => entry.type === 'query');
    const expected = summarizeStats({
      entries,
      type: 'query',
      windowStart: new Date(NOW - HOUR),
      windowEnd: new Date(NOW),
      windowMs: HOUR,
      buckets: 60,
      slowMs: 100,
      truncated: false,
    });

    const actual = await new MetricsService(store).getStats({ type: 'query', windowMs: HOUR });

    expect(actual.families).toEqual(expected.families);
    expect(actual.families?.map((family) => family.label)).toContain(
      'select * from orders where user_id = 35',
    );
    expect(returnedQueriesWithContent).toBe(0);
  });
});
