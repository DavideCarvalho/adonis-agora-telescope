import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOrigin,
  getOriginScopeDriver,
  isHeartbeat,
  ORIGIN_SCOPE_KEY,
  resolveOrigin,
  runAsHeartbeat,
  runWithOrigin,
} from '../src/origin_scope.js';
import { setTelescopeRecordHeartbeat } from '../src/registry.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { safeRecord } from '../src/watchers/record.js';
import { clearStore, flush, installStore } from './watchers/helpers.js';

afterEach(() => {
  clearStore();
});

describe('origin scope', () => {
  it('reports no origin and no heartbeat outside any scope', () => {
    expect(currentOrigin()).toBe(null);
    expect(isHeartbeat()).toBe(false);
  });

  it('labels the work inside it', () => {
    runWithOrigin('schedule', () => {
      expect(currentOrigin()).toBe('schedule');
    });
    expect(currentOrigin()).toBe(null);
  });

  it('survives an await — the scope must reach the store call, not just the sync frame', async () => {
    await runWithOrigin('queue', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentOrigin()).toBe('queue');
    });
  });

  it('keeps the enclosing origin when a probe nests inside it', () => {
    runWithOrigin('schedule', () => {
      runAsHeartbeat(() => {
        // Both, not either: the drop decision reads `heartbeat`, and anything that
        // IS recorded from here still has to say where it came from.
        expect(currentOrigin()).toBe('schedule');
        expect(isHeartbeat()).toBe(true);
      });
      // The probe ends where its scope ends — the work the tick goes on to do is
      // not a probe, which is the whole distinction.
      expect(isHeartbeat()).toBe(false);
    });
  });

  it('publishes one driver on the global slot so a second copy reuses it', () => {
    expect((globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE_KEY]).toBe(getOriginScopeDriver());
  });

  it('lets a sibling lib drive the scope structurally, without importing telescope', () => {
    // Exactly what @adonis-agora/durable does: read the slot, run through it.
    const driver = (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE_KEY] as {
      run<T>(scope: { origin?: string; heartbeat?: boolean }, fn: () => T): T;
    };
    driver.run({ origin: 'schedule', heartbeat: true }, () => {
      expect(currentOrigin()).toBe('schedule');
      expect(isHeartbeat()).toBe(true);
    });
  });
});

describe('resolveOrigin', () => {
  it('prefers an explicit per-entry origin over the ambient scope', () => {
    runWithOrigin('schedule', () => {
      expect(resolveOrigin('http')).toBe('http');
    });
  });

  it('falls back to the ambient scope, then to manual', () => {
    runWithOrigin('cli', () => {
      expect(resolveOrigin(undefined)).toBe('cli');
    });
    expect(resolveOrigin(undefined)).toBe('manual');
  });

  it('ignores a value that is not a known origin', () => {
    expect(resolveOrigin('nonsense')).toBe('manual');
  });
});

describe('the store persists the ambient origin', () => {
  it('stamps entries recorded inside a scope', async () => {
    const store = new InMemoryTelescopeStore();
    const entry = await runWithOrigin('schedule', () =>
      store.record({ type: 'query', content: {} }),
    );
    expect(entry.origin).toBe('schedule');
  });

  it('still defaults to manual with no scope', async () => {
    const store = new InMemoryTelescopeStore();
    const entry = await store.record({ type: 'query', content: {} });
    expect(entry.origin).toBe('manual');
  });
});

describe('heartbeat suppression', () => {
  it('drops a probe by default', async () => {
    const store = installStore();
    runAsHeartbeat(() => safeRecord({ type: 'query', content: {} }, 'test'));
    await flush();
    expect(await store.count()).toBe(0);
  });

  it('records the work the probe leads to', async () => {
    const store = installStore();
    runWithOrigin('schedule', () => {
      runAsHeartbeat(() => safeRecord({ type: 'query', content: { sql: 'probe' } }, 'test'));
      safeRecord({ type: 'query', content: { sql: 'work' } }, 'test');
    });
    await flush();
    const kept = await store.list({ limit: 10 });
    expect(kept.map((e) => (e.content as { sql: string }).sql)).toEqual(['work']);
    expect(kept[0]?.origin).toBe('schedule');
  });

  it('keeps probes when the host opts in', async () => {
    const store = installStore();
    setTelescopeRecordHeartbeat(true);
    runAsHeartbeat(() => safeRecord({ type: 'query', content: {} }, 'test'));
    await flush();
    expect(await store.count()).toBe(1);
  });
});
