import * as perfHooks from 'node:perf_hooks';
import type { ResolvedTelescopeConfig } from './define_config.js';

/** How often the guard samples the lag histogram. */
const SAMPLE_INTERVAL_MS = 1_000;
const NS_PER_MS = 1e6;

/** The resolved overload-guard slice of the telescope config. */
export type ResolvedOverloadConfig = ResolvedTelescopeConfig['overload'];

/**
 * The pause surface the guard toggles: the ingestion path is expected to become a
 * dropping no-op while `isPaused` is `true`. The provider backs this with the
 * global runtime `paused` flag the request middleware and watcher `safeRecord`
 * honour, so a pause sheds ingestion across every recording entry point at once.
 */
export interface PauseController {
  pause(): void;
  resume(): void;
  readonly isPaused: boolean;
}

/** The minimal `perf_hooks` monitor surface the guard reads — injectable for tests. */
export interface EventLoopDelayMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  /** Delay at the given percentile, in nanoseconds. */
  percentile(percentile: number): number;
}

/** The sink for the guard's operational messages. Defaults to `console`. */
export interface OverloadLogger {
  warn(message: string): void;
  log?(message: string): void;
}

/** Constructor seams for {@link OverloadGuard} (monitor factory + logger). */
export interface OverloadGuardDeps {
  /** Build the event-loop-delay monitor. Defaults to `perf_hooks`; `null` ⇒ no-op. */
  monitorFactory?: () => EventLoopDelayMonitor | null;
  logger?: OverloadLogger;
}

/**
 * Overload protection. Samples the process event-loop delay histogram
 * (`perf_hooks.monitorEventLoopDelay`) on an interval and PAUSES ingestion via the
 * {@link PauseController} when the p99 lag crosses the configured threshold,
 * resuming once it recovers — so a telescope under load can never amplify an
 * incident.
 *
 * A startup grace (default ~5s) discards the first measurement windows so the
 * synchronous boot stall (provider wiring, migrations) never trips the guard on a
 * transient. Degrades to a no-op when `perf_hooks.monitorEventLoopDelay` is
 * unavailable or `overload.enabled` is `false`. The sampling interval is unref'd so
 * it never keeps the host's event loop alive.
 *
 * Ported from `nestjs-telescope`'s `TelescopeOverloadGuard`; the only adaptation is
 * that it pauses a {@link PauseController} (the runtime flag) rather than a NestJS
 * Recorder, matching this package's DI-free ingestion path.
 */
export class OverloadGuard {
  private readonly maxLagMs: number | null;
  /**
   * Number of leading sample windows still to discard for the startup grace.
   * Counts down on every sample taken while warming up, after which the guard
   * judges normally.
   */
  private warmupSamplesRemaining: number;
  private monitor: EventLoopDelayMonitor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly monitorFactory: () => EventLoopDelayMonitor | null;
  private readonly logger: OverloadLogger;

  constructor(
    config: ResolvedOverloadConfig,
    private readonly controller: PauseController,
    deps: OverloadGuardDeps = {},
  ) {
    this.maxLagMs = config.enabled ? config.maxEventLoopLagMs : null;
    // Round UP so a sub-interval grace still discards at least one window (the one
    // that holds the bootstrap stall). 0ms ⇒ 0 windows ⇒ no grace.
    this.warmupSamplesRemaining = Math.ceil(config.startupGraceMs / SAMPLE_INTERVAL_MS);
    this.monitorFactory = deps.monitorFactory ?? startMonitor;
    this.logger = deps.logger ?? console;
  }

  /**
   * Arm the guard: start the monitor + sampling timer. A no-op when protection is
   * off, already started, or `perf_hooks` lacks the monitor.
   */
  start(): void {
    if (this.maxLagMs === null || this.timer) return;
    this.monitor = this.monitorFactory();
    if (this.monitor === null) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop sampling and disable the monitor (called by the provider at shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.monitor?.disable();
    this.monitor = null;
  }

  /** Run exactly one sampling tick. Exposed so tests can drive the guard deterministically. */
  sampleOnce(): void {
    this.sample();
  }

  /** Read the rolling p99 lag and pause/resume ingestion around the threshold. */
  private sample(): void {
    const monitor = this.monitor;
    const maxLagMs = this.maxLagMs;
    if (monitor === null || maxLagMs === null) return;
    let p99Ms: number;
    try {
      p99Ms = monitor.percentile(99) / NS_PER_MS;
    } catch {
      return; // A misbehaving monitor must never crash the host.
    }
    // Reset the histogram each cycle so the decision reflects the RECENT window (a
    // per-process accumulation would never recover once lag spiked).
    monitor.reset();
    // Startup grace: discard the leading window(s) — they carry the boot stall, not
    // live load. Reset above still ran, so the NEXT judged window starts clean.
    if (this.warmupSamplesRemaining > 0) {
      this.warmupSamplesRemaining -= 1;
      return;
    }
    if (p99Ms >= maxLagMs) {
      if (!this.controller.isPaused) {
        this.logger.warn(
          `Event-loop p99 lag ${p99Ms.toFixed(0)}ms >= ${maxLagMs}ms — pausing Telescope capture.`,
        );
        this.controller.pause();
      }
    } else if (this.controller.isPaused) {
      const info = this.logger.log ?? this.logger.warn;
      info.call(
        this.logger,
        `Event-loop p99 lag ${p99Ms.toFixed(0)}ms recovered — resuming Telescope capture.`,
      );
      this.controller.resume();
    }
  }
}

/** Start an enabled event-loop-delay monitor, or `null` if perf_hooks lacks it. */
function startMonitor(): EventLoopDelayMonitor | null {
  const factory: unknown = perfHooks.monitorEventLoopDelay;
  if (typeof factory !== 'function') return null;
  try {
    const monitor: unknown = factory();
    if (!isEventLoopDelayMonitor(monitor)) return null;
    monitor.enable();
    return monitor;
  } catch {
    return null;
  }
}

/** Structural guard: confirms a value exposes the monitor surface we read. */
function isEventLoopDelayMonitor(value: unknown): value is EventLoopDelayMonitor {
  if (typeof value !== 'object' || value === null) return false;
  if (!('enable' in value) || !('disable' in value)) return false;
  if (!('reset' in value) || !('percentile' in value)) return false;
  return (
    typeof value.enable === 'function' &&
    typeof value.disable === 'function' &&
    typeof value.reset === 'function' &&
    typeof value.percentile === 'function'
  );
}
