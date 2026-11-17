import { describe, expect, it } from 'vitest';
import { PulseService } from '../../src/metrics/pulse.js';
import type { TelescopeStore } from '../../src/store.js';

/**
 * A store with the aggregate fast paths but no `listDurations` reads the window's diagnostics
 * newest first and keeps the durable steps. When that read hits `scanCap`, steps can sit past the
 * cap even if none of the listed rows is a step — the summary must say `truncated`.
 */
describe('pulse: durable steps from a store without listDurations', () => {
  const now = Date.now();
  const diagnostics = Array.from({ length: 3 }, (_, i) => ({
    id: `d${i}`,
    type: 'diagnostic',
    familyHash: 'billing:sync',
    durationMs: 5,
    createdAt: new Date(now - 1_000 - i),
    sequence: i,
    tags: [],
    content: {},
  }));

  const store = {
    record: async () => undefined,
    get: async () => null,
    count: async () => 0,
    prune: async () => 0,
    clear: async () => undefined,
    list: async (query?: { type?: string; size?: number }) =>
      query?.type === 'diagnostic' ? diagnostics.slice(0, query.size) : [],
    countByBucket: async () => [],
    listSlowest: async () => [],
    countTraceRepeats: async () => [],
    honorsTagGroups: true,
  } as unknown as TelescopeStore;

  it('is truncated when the diagnostic read hit the cap, even with no step among the rows', async () => {
    const summary = await new PulseService(store, { scanCap: 3 }).getHealth({
      windowMs: 3_600_000,
      cards: ['slowJobs'],
    });
    expect(summary.slowWork).toEqual([]);
    expect(summary.truncated).toBe(true);
  });

  it('is not truncated when the read stayed under the cap', async () => {
    const summary = await new PulseService(store, { scanCap: 10 }).getHealth({
      windowMs: 3_600_000,
      cards: ['slowJobs'],
    });
    expect(summary.truncated).toBe(false);
  });
});
