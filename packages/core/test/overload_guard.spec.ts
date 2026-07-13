import { describe, expect, it, vi } from 'vitest';
import {
  type EventLoopDelayMonitor,
  OverloadGuard,
  type PauseController,
  type ResolvedOverloadConfig,
} from '../src/overload_guard.js';

const silent = { warn() {}, log() {} };

/** A fake monitor whose p99 (ns) is read from `p99Ns()`, counting its resets. */
function fakeMonitor(p99Ns: () => number): EventLoopDelayMonitor & { resets: number } {
  return {
    resets: 0,
    enable() {},
    disable() {},
    reset() {
      this.resets += 1;
    },
    percentile() {
      return p99Ns();
    },
  };
}

/** A fake pause target that records the paused state. */
function fakeController(): PauseController & { paused: boolean } {
  return {
    paused: false,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    get isPaused() {
      return this.paused;
    },
  };
}

function cfg(over: Partial<ResolvedOverloadConfig> = {}): ResolvedOverloadConfig {
  return { enabled: true, maxEventLoopLagMs: 200, startupGraceMs: 0, ...over };
}

describe('OverloadGuard', () => {
  it('pauses when p99 lag crosses the threshold and resumes when it recovers', () => {
    let lagMs = 0;
    const monitor = fakeMonitor(() => lagMs * 1e6);
    const controller = fakeController();
    const guard = new OverloadGuard(cfg(), controller, {
      monitorFactory: () => monitor,
      logger: silent,
    });
    guard.start();

    lagMs = 50;
    guard.sampleOnce();
    expect(controller.isPaused).toBe(false);

    lagMs = 250;
    guard.sampleOnce();
    expect(controller.isPaused).toBe(true);

    lagMs = 10;
    guard.sampleOnce();
    expect(controller.isPaused).toBe(false);

    guard.stop();
  });

  it('discards leading windows during the startup grace before it can pause', () => {
    const monitor = fakeMonitor(() => 500 * 1e6); // always over threshold
    const controller = fakeController();
    // 2500ms grace over a 1000ms window ⇒ ceil = 3 discarded windows.
    const guard = new OverloadGuard(cfg({ startupGraceMs: 2500 }), controller, {
      monitorFactory: () => monitor,
      logger: silent,
    });
    guard.start();

    guard.sampleOnce();
    guard.sampleOnce();
    guard.sampleOnce();
    expect(controller.isPaused).toBe(false);
    // The histogram is still reset each warmup window so the first judged one is clean.
    expect(monitor.resets).toBe(3);

    guard.sampleOnce(); // first judged window
    expect(controller.isPaused).toBe(true);
  });

  it('is a no-op when disabled (never even builds the monitor)', () => {
    const factory = vi.fn(() => fakeMonitor(() => 999 * 1e6));
    const controller = fakeController();
    const guard = new OverloadGuard(cfg({ enabled: false }), controller, {
      monitorFactory: factory,
      logger: silent,
    });
    guard.start();
    guard.sampleOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(controller.isPaused).toBe(false);
  });

  it('degrades to a no-op when the monitor is unavailable', () => {
    const controller = fakeController();
    const guard = new OverloadGuard(cfg(), controller, {
      monitorFactory: () => null,
      logger: silent,
    });
    guard.start();
    guard.sampleOnce();
    expect(controller.isPaused).toBe(false);
  });

  it('swallows a throwing percentile read (never crashes the host)', () => {
    const monitor: EventLoopDelayMonitor = {
      enable() {},
      disable() {},
      reset() {},
      percentile() {
        throw new Error('boom');
      },
    };
    const controller = fakeController();
    const guard = new OverloadGuard(cfg(), controller, {
      monitorFactory: () => monitor,
      logger: silent,
    });
    guard.start();
    expect(() => guard.sampleOnce()).not.toThrow();
    expect(controller.isPaused).toBe(false);
  });

  it('samples on the interval timer and stops sampling on stop()', () => {
    vi.useFakeTimers();
    try {
      const percentile = vi.fn(() => 10 * 1e6);
      const monitor: EventLoopDelayMonitor = {
        enable() {},
        disable() {},
        reset() {},
        percentile,
      };
      const controller = fakeController();
      const guard = new OverloadGuard(cfg(), controller, {
        monitorFactory: () => monitor,
        logger: silent,
      });

      guard.start();
      vi.advanceTimersByTime(1_000);
      expect(percentile).toHaveBeenCalledTimes(1);

      guard.stop();
      vi.advanceTimersByTime(3_000);
      expect(percentile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
