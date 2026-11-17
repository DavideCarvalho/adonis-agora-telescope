import { describe, expect, it, vi } from 'vitest';
import { PulseService } from '../../src/metrics/pulse.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { TelescopeApi } from '../../src/ui/api.js';

/**
 * A page that shows a few Pulse cards asks for those only (`cards`), and the server skips the
 * reads behind the others: the Overview never shows the cache or outgoing-call cards, and their
 * lists were whole-window reads on every load.
 */
async function seeded() {
  const store = new InMemoryTelescopeStore();
  await store.record({
    type: 'request',
    content: { method: 'GET', url: '/a', status: 200 },
    durationMs: 5,
    tags: [],
  });
  await store.record({ type: 'cache', content: { operation: 'hit', key: 'k' }, tags: [] });
  await store.record({
    type: 'http-client',
    content: { method: 'GET', url: 'https://x' },
    familyHash: 'GET x',
    durationMs: 2000,
    tags: [],
  });
  return store;
}

const fastPaths = () => ({
  countByBucket: vi.fn().mockResolvedValue([{ index: 0, type: 'request', count: 1 }]),
  listSlowest: vi.fn().mockResolvedValue([]),
  countTraceRepeats: vi.fn().mockResolvedValue([]),
});

describe('Pulse cards', () => {
  it('reads nothing for the cards left out', async () => {
    const memory = await seeded();
    const list = vi.spyOn(memory, 'list');
    const store = Object.assign(memory, fastPaths());
    const pulse = new PulseService(store);

    const summary = await pulse.getHealth({ cards: ['requests', 'throughput'] });

    const types = list.mock.calls.map(([query]) => query?.type);
    expect(types).toContain('request');
    expect(types).not.toContain('cache');
    expect(types).not.toContain('http-client');
    expect(summary.cache).toBeUndefined();
    expect(summary.slowOutgoing).toEqual([]);
    expect(summary.requests.total).toBe(1);
    expect(summary.throughput.overTime.buckets.length).toBeGreaterThan(0);
  });

  it('ignores unknown names, and every configured card when none is left', async () => {
    const pulse = new PulseService(await seeded());
    const all = await pulse.getHealth({ cards: ['nope'] });
    expect(all.slowOutgoing.map((h) => h.route)).toEqual(['GET x']);
  });

  it('cannot turn on a card the config turned off', async () => {
    const pulse = new PulseService(await seeded(), { cards: ['requests'] });
    const summary = await pulse.getHealth({ cards: ['slowOutgoing', 'requests'] });
    expect(summary.slowOutgoing).toEqual([]);
    expect(summary.requests.total).toBe(1);
  });

  it('GET /metrics/pulse?cards= narrows the cards', async () => {
    const api = new TelescopeApi(new TelescopeService(await seeded()));
    let body: { data: { slowOutgoing: unknown[]; requests: { total: number } } } | undefined;
    const response = {
      status: () => response,
      header: () => response,
      send: (value: unknown) => {
        body = value as typeof body;
        return response;
      },
    };
    await api.metricsPulse({
      request: { qs: () => ({ cards: 'requests, throughput' }), param: () => undefined },
      response,
    } as never);
    expect(body?.data.slowOutgoing).toEqual([]);
    expect(body?.data.requests.total).toBe(1);
  });
});
