import { describe, expect, it, vi } from 'vitest';
import { type ResolvedPruneConfig, TelescopePruner } from '../src/pruner.js';
import type { TelescopeStore } from '../src/store.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

/** A logger that swallows the pruner's operational warnings during tests. */
const silent = { warn() {} };

function cfg(over: Partial<ResolvedPruneConfig> = {}): ResolvedPruneConfig {
  return { enabled: true, afterMs: 1_000, intervalMs: 60_000, ...over };
}

/** Set an entry's createdAt so age-based pruning is deterministic. */
function ageEntry(entry: { createdAt: Date }, at: number): void {
  entry.createdAt = new Date(at);
}

describe('TelescopePruner', () => {
  it('pruneNow deletes entries older than the cutoff and records a manual run', async () => {
    const store = new InMemoryTelescopeStore();
    const now = 1_000_000_000_000;
    const old = await store.record({ type: 'x', content: 'old' });
    ageEntry(old as { createdAt: Date }, now - 10_000);
    const fresh = await store.record({ type: 'x', content: 'new' });
    ageEntry(fresh as { createdAt: Date }, now - 100);

    const pruner = new TelescopePruner(store, cfg({ afterMs: 5_000 }), {
      clock: { now: () => now },
      logger: silent,
    });
    const deleted = await pruner.pruneNow();

    expect(deleted).toBe(1);
    expect(await store.count()).toBe(1);
    expect(await store.get(old.id)).toBeNull();

    const runs = pruner.getRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('manual');
    expect(runs[0]?.deletedTotal).toBe(1);
    expect(runs[0]?.error).toBeUndefined();
    expect(runs[0]?.at).toBe(new Date(now).toISOString());
  });

  it('respects keepLast (count-based retention)', async () => {
    const store = new InMemoryTelescopeStore();
    const now = 1_000_000_000_000;
    for (let i = 0; i < 4; i++) {
      const e = await store.record({ type: 'x', content: i });
      ageEntry(e as { createdAt: Date }, now - 10_000 + i);
    }
    const pruner = new TelescopePruner(store, cfg({ afterMs: 1_000, keepLast: 2 }), {
      clock: { now: () => now },
      logger: silent,
    });
    expect(await pruner.pruneNow()).toBe(2);
    expect(await store.count()).toBe(2);
  });

  it('captures a store failure on the run and never throws', async () => {
    const store = {
      prune: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as TelescopeStore;
    const pruner = new TelescopePruner(store, cfg(), { logger: silent });

    await expect(pruner.pruneNow()).resolves.toBe(0);
    const runs = pruner.getRuns();
    expect(runs[0]?.deletedTotal).toBe(0);
    expect(runs[0]?.error).toBe('db down');
  });

  it('runs scheduled cycles on the interval timer and stops on stop()', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryTelescopeStore();
      const prune = vi.spyOn(store, 'prune');
      const pruner = new TelescopePruner(store, cfg({ intervalMs: 1_000 }), { logger: silent });

      pruner.start();
      expect(prune).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(pruner.getRuns()[0]?.trigger).toBe('scheduled');

      pruner.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(prune).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() is a no-op and nextRunAt is null when disabled', () => {
    const store = new InMemoryTelescopeStore();
    const pruner = new TelescopePruner(store, cfg({ enabled: false }), { logger: silent });
    pruner.start();
    expect(pruner.getNextRunAtMs()).toBeNull();
    expect(pruner.getRuns()).toHaveLength(0);
  });

  it('predicts the next scheduled run from the clock + interval', () => {
    const store = new InMemoryTelescopeStore();
    const pruner = new TelescopePruner(store, cfg({ intervalMs: 1_000 }), {
      clock: { now: () => 5_000 },
      logger: silent,
    });
    expect(pruner.getNextRunAtMs()).toBe(6_000);
  });

  it('keeps recent runs newest-first, capped at 100', async () => {
    const store = new InMemoryTelescopeStore();
    const pruner = new TelescopePruner(store, cfg(), { logger: silent });
    for (let i = 0; i < 105; i++) await pruner.pruneNow();
    expect(pruner.getRuns()).toHaveLength(100);
  });
});
