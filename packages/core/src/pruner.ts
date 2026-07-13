import type { ResolvedTelescopeConfig } from './define_config.js';
import type { TelescopeStore } from './store.js';

/** What kicked off a prune cycle: the interval timer, or an on-demand request. */
export type PruneTrigger = 'scheduled' | 'manual';

/**
 * One recorded prune cycle, kept in an in-memory ring buffer on the pruner so a
 * future dashboard can show retention activity. Prune runs are deliberately NOT
 * stored as telescope entries — they would be pruned themselves and add write
 * load to the very store retention is meant to shrink.
 */
export interface PruneRun {
  /** ISO timestamp when the cycle started. */
  at: string;
  trigger: PruneTrigger;
  /** Wall-clock duration of the whole cycle. */
  durationMs: number;
  /** Number of entries deleted this cycle. */
  deletedTotal: number;
  /** The step error message captured this cycle, if the delete threw (swallowed + logged). */
  error?: string;
}

/** Ring-buffer cap for recent prune runs (newest-first). */
const MAX_PRUNE_RUNS = 100;

/** The resolved pruner slice of the telescope config. */
export type ResolvedPruneConfig = ResolvedTelescopeConfig['prune'];

/** A monotonic-ish wall clock, injectable so time-based pruning is testable. */
export interface Clock {
  now(): number;
}

/** The sink for the pruner's operational warnings. Defaults to `console`. */
export interface PrunerLogger {
  warn(message: string): void;
}

/** Constructor seams for {@link TelescopePruner} (clock + logger), all optional. */
export interface PrunerDeps {
  clock?: Clock;
  logger?: PrunerLogger;
}

/**
 * Background retention for a {@link TelescopeStore}. On a timer (and on demand via
 * {@link pruneNow}) it deletes entries older than the configured cutoff, optionally
 * keeping the newest `keepLast` — so the store never grows without bound.
 *
 * Ported from `nestjs-telescope`'s `TelescopePruner`, trimmed to this headless
 * slice: a single global cutoff (the store contract exposes one `prune`, with no
 * per-type/`pruneScoped` variant yet — see DEFERRED), plus the recent-runs ring
 * buffer and the fire-and-forget, never-throw scheduling that keeps a slow or
 * failing store from ever crashing the host.
 */
export class TelescopePruner {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Recent prune cycles, newest-first, capped at {@link MAX_PRUNE_RUNS}. */
  private readonly runs: PruneRun[] = [];
  /** Start time (epoch ms) of the most recent SCHEDULED cycle, for nextRunAt. */
  private lastScheduledRunAtMs: number | null = null;
  private readonly clock: Clock;
  private readonly logger: PrunerLogger;

  constructor(
    private readonly store: TelescopeStore,
    private readonly config: ResolvedPruneConfig,
    deps: PrunerDeps = {},
  ) {
    this.clock = deps.clock ?? Date;
    this.logger = deps.logger ?? console;
  }

  /**
   * Arm the interval timer. A no-op when pruning is disabled or already started.
   * The timer is unref'd so it never keeps the host's event loop alive, and every
   * cycle is fire-and-forget with a final catch so a rejection can never become an
   * unhandled rejection or crash the host.
   */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.runCycle('scheduled').catch((error: unknown) => {
        this.logger.warn(`Telescope prune failed: ${asError(error).message}`);
      });
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the interval timer (called by the provider at shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run ONE prune cycle on demand (e.g. a future dashboard's "Prune now"),
   * recording it as a `manual` run. Resolves to the number of entries deleted.
   */
  async pruneNow(): Promise<number> {
    return this.runCycle('manual');
  }

  /** Recent prune runs (newest-first), copied so callers can't mutate the ring. */
  getRuns(): PruneRun[] {
    return [...this.runs];
  }

  /**
   * Predicted next SCHEDULED prune time (epoch ms), or null when pruning is
   * disabled. Derived from the last scheduled run's start + the interval, falling
   * back to now + interval before the first cycle has run.
   */
  getNextRunAtMs(): number | null {
    if (!this.config.enabled) return null;
    return (this.lastScheduledRunAtMs ?? this.clock.now()) + this.config.intervalMs;
  }

  /**
   * One prune tick: delete everything older than `now - afterMs`, keeping the
   * newest `keepLast` of the doomed set when configured. The delete is guarded so
   * a throwing/slow store is captured on the run and never propagates.
   */
  private async runCycle(trigger: PruneTrigger): Promise<number> {
    const startedAtMs = this.clock.now();
    const cutoff = new Date(startedAtMs - this.config.afterMs);
    let deletedTotal = 0;
    let error: string | undefined;
    try {
      deletedTotal = await this.store.prune(cutoff, this.config.keepLast);
    } catch (caught: unknown) {
      error = asError(caught).message;
      this.logger.warn(`Telescope prune step failed: ${error}`);
    }

    if (trigger === 'scheduled') this.lastScheduledRunAtMs = startedAtMs;
    this.recordRun({
      at: new Date(startedAtMs).toISOString(),
      trigger,
      durationMs: this.clock.now() - startedAtMs,
      deletedTotal,
      ...(error !== undefined ? { error } : {}),
    });
    return deletedTotal;
  }

  /**
   * Append a run to the newest-first ring buffer, evicting the oldest past the
   * cap. Recording must NEVER throw into the prune path, so it is fully guarded.
   */
  private recordRun(run: PruneRun): void {
    try {
      this.runs.unshift(run);
      while (this.runs.length > MAX_PRUNE_RUNS) this.runs.pop();
    } catch (error: unknown) {
      this.logger.warn(`Telescope failed to record prune run: ${asError(error).message}`);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
