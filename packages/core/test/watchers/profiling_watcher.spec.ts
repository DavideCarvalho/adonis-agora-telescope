import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/watchers/define_config.js';
import type { ProfileEntryContent } from '../../src/watchers/profiling_watcher.js';
import {
  ProfilingWatcher,
  buildProfileEntry,
  profile,
  startProfile,
} from '../../src/watchers/profiling_watcher.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A monotonic fake clock so durations/marks are deterministic. */
function fakeClock(start = 0): { now(): number; advance(by: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (by: number) => {
      t += by;
    },
  };
}

describe('buildProfileEntry', () => {
  it('records label, duration, marks and a profile family hash', () => {
    const input = buildProfileEntry({
      label: 'checkout',
      durationMs: 42,
      status: 'completed',
      marks: [{ label: 'validated', atMs: 10 }],
    });
    expect(input.type).toBe('profile');
    expect(input.familyHash).toBe('profile:checkout');
    expect(input.durationMs).toBe(42);
    const content = input.content as ProfileEntryContent;
    expect(content.label).toBe('checkout');
    expect(content.marks).toEqual([{ label: 'validated', atMs: 10 }]);
    expect(input.tags).toContain('profile');
    expect(input.tags).toContain('profile:checkout');
    expect(input.tags).not.toContain('slow');
  });

  it('tags a slow span and a failed span', () => {
    const input = buildProfileEntry(
      { label: 'slow', durationMs: 250, status: 'failed', marks: [], error: new Error('boom') },
      100,
    );
    expect(input.tags).toContain('slow');
    expect(input.tags).toContain('failed');
    expect((input.content as ProfileEntryContent).failureReason).toBe('boom');
  });
});

describe('ProfilingWatcher', () => {
  afterEach(() => clearStore());

  it('records a completed span with duration and nested marks', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ProfilingWatcher({ clock });

    const span = watcher.startProfile('checkout');
    clock.advance(5);
    span.mark('cart-loaded');
    clock.advance(15);
    span.mark('priced');
    clock.advance(5);
    span.end();

    await flush();
    const [entry] = await store.list({});
    expect(entry.type).toBe('profile');
    expect(entry.durationMs).toBe(25);
    const content = entry.content as ProfileEntryContent;
    expect(content.status).toBe('completed');
    expect(content.marks).toEqual([
      { label: 'cart-loaded', atMs: 5 },
      { label: 'priced', atMs: 20 },
    ]);
  });

  it('profile() times a function, passes the session for marks, and returns its value', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ProfilingWatcher({ clock });

    const result = watcher.profile('work', (span) => {
      clock.advance(8);
      span.mark('half');
      clock.advance(8);
      return 'done';
    });

    expect(result).toBe('done');
    await flush();
    const [entry] = await store.list({});
    expect(entry.durationMs).toBe(16);
    expect((entry.content as ProfileEntryContent).marks).toEqual([{ label: 'half', atMs: 8 }]);
  });

  it('records a failed span and re-throws for an async fn', async () => {
    const store = installStore();
    const watcher = new ProfilingWatcher();

    await expect(
      watcher.profile('boom', async () => {
        throw new Error('kaput');
      }),
    ).rejects.toThrow('kaput');

    await flush();
    const [entry] = await store.list({});
    const content = entry.content as ProfileEntryContent;
    expect(content.status).toBe('failed');
    expect(content.failureReason).toBe('kaput');
    expect(entry.tags).toContain('failed');
  });

  it('honours the slow-span threshold tag', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ProfilingWatcher({ slowMs: 50, clock });

    const span = watcher.startProfile('slow');
    clock.advance(120);
    span.end();

    await flush();
    const [entry] = await store.list({});
    expect(entry.tags).toContain('slow');
  });

  it('discards spans below minDurationMs', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ProfilingWatcher({ minDurationMs: 10, clock });

    const span = watcher.startProfile('quick');
    clock.advance(3);
    span.end();

    await flush();
    expect(await store.count()).toBe(0);
  });

  it('records nothing while paused (overload shed)', async () => {
    const store = installStore();
    const { setTelescopePaused } = await import('../../src/registry.js');
    setTelescopePaused(true);
    try {
      new ProfilingWatcher().profile('x', () => 1);
      await flush();
      expect(await store.count()).toBe(0);
    } finally {
      setTelescopePaused(false);
    }
  });

  it('end()/fail() are idempotent — a settled span records once', async () => {
    const store = installStore();
    const watcher = new ProfilingWatcher();
    const span = watcher.startProfile('once');
    span.end();
    span.end();
    span.fail(new Error('late'));
    await flush();
    expect(await store.count()).toBe(1);
  });
});

describe('standalone profile()/startProfile() (opt-in default slot)', () => {
  afterEach(() => clearStore());

  it('is a zero-cost no-op passthrough when no watcher is published', async () => {
    const store = installStore();
    expect(profile('x', () => 7)).toBe(7);
    const span = startProfile('y');
    span.mark('m').end();
    await flush();
    expect(await store.count()).toBe(0);
  });

  it('records through the published default once the watcher is started', async () => {
    const store = installStore();
    const watcher = new ProfilingWatcher();
    watcher.start();
    try {
      expect(profile('checkout', () => 'ok')).toBe('ok');
      await flush();
      expect(await store.count()).toBe(1);
    } finally {
      watcher.stop();
    }
    // after stop, the helper is a no-op again
    profile('after', () => 1);
    await flush();
    expect(await store.count()).toBe(1);
  });
});

describe('watchers config — profiling', () => {
  it('defaults the profiling watcher config (100ms slow, 0 floor)', () => {
    const { profiling } = resolveConfig();
    expect(profiling.slowMs).toBe(100);
    expect(profiling.minDurationMs).toBe(0);
  });

  it('honours an explicit profiling config and can be enabled', () => {
    const config = resolveConfig({
      watchers: ['query', 'profiling'],
      profiling: { slowMs: 25, minDurationMs: 5 },
    });
    expect(config.watchers.has('profiling')).toBe(true);
    expect(config.profiling.slowMs).toBe(25);
    expect(config.profiling.minDurationMs).toBe(5);
  });
});
