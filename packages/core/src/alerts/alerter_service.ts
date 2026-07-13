import { EntryType } from '../entry.js';
import type { StatsResult } from '../metrics/stats.js';
import { getTelescopeRuntime } from '../registry.js';
import type { AlertChannel } from './alert_channel.js';
import type { AlertMetric, AlertPayload, AlertRule, ResolvedAlerts } from './alert_rule.js';
import { durationToMs } from './parse_duration.js';

/** The metric-threshold member of the rule union — the only rule this service owns. */
type MetricThresholdRule = Extract<AlertRule, { type: 'metric-threshold' }>;

/**
 * The narrow read the {@link AlerterService} needs from the metrics layer:
 * per-type windowed stats. `MetricsService` satisfies this structurally, so the
 * service reuses the SAME `summarizeStats`/`percentile` aggregation the dashboard
 * shows and NEVER re-implements windowed aggregation. A test can pass any object
 * with a `getStats`.
 */
export interface MetricSource {
  getStats(query: { type: string; windowMs: number; buckets?: number }): Promise<StatsResult>;
}

export interface AlerterServiceDeps {
  /** Boot-resolved alerting config (channels, cooldown, rules, instanceId). */
  alerts: ResolvedAlerts;
  /** Windowed metrics source (typically the core `MetricsService`). */
  metrics: MetricSource;
  /** Wall-clock seam (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Failure log sink. Defaults to `console.warn`. */
  logger?: (message: string) => void;
  /**
   * Returns `true` while the overload guard has shed load — evaluation is skipped
   * so a struggling host isn't scanned for alerts. Defaults to the shared
   * telescope runtime's `paused` flag.
   */
  isPaused?: () => boolean;
}

/**
 * Interval-driven, stateful threshold alerting (the `metric-threshold` rule).
 *
 * A plain service in the shape of `MetricsService`/`PulseService`: on an unref'd
 * timer it evaluates every configured `metric-threshold` rule over its trailing
 * window by reading the injected {@link MetricSource} (reusing the dashboard's own
 * `summarizeStats`/`percentile` aggregation — it computes NO aggregates itself),
 * and it maintains a per-rule RAISE/RESOLVE state machine:
 *
 *  - not active + metric crosses the threshold  → RAISE  (dispatch `status:'firing'`);
 *  - active + metric no longer crosses          → RESOLVE (dispatch `status:'resolved'`);
 *  - active + still crossing                     → dedup (no duplicate raise);
 *  - a just-resolved rule is held down for `cooldownMs` before it can re-raise
 *    (flap control).
 *
 * Each dispatched alert fans out to ALL channels concurrently; one channel failing
 * never blocks the others. NEVER throws into the caller/timer: an evaluation or
 * channel failure is warn-logged (rate-limited per channel) and otherwise swallowed.
 */
export class AlerterService {
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private readonly isPaused: () => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rule indices currently in the FIRING state (the dedup + resolve keys). */
  private readonly active = new Set<number>();
  /** Per-rule wall time of the last RESOLVE, for the post-resolve cooldown. */
  private readonly lastResolvedAt = new Map<number, number>();
  /** Channels we've already warned about (rate-limit failure logs by name). */
  private readonly warnedChannels = new Set<string>();

  constructor(private readonly deps: AlerterServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? ((message) => console.warn(message));
    this.isPaused =
      deps.isPaused ??
      (() => {
        try {
          return getTelescopeRuntime().paused;
        } catch {
          return false;
        }
      });
  }

  /** Start the unref'd evaluation interval. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.evaluateOnce().catch((error: unknown) => {
        this.logger(`Telescope alert evaluation failed: ${asMessage(error)}`);
      });
    }, this.deps.alerts.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the interval (shutdown). Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of rules currently in the firing state (test/observability seam). */
  get activeAlerts(): number {
    return this.active.size;
  }

  /**
   * Evaluate every `metric-threshold` rule once and raise/resolve accordingly.
   * A no-op when alerting is disabled or the host is shedding load. Never throws:
   * a single rule's evaluation error is logged and the others still run. Exposed
   * for the timer and for deterministic tests.
   */
  async evaluateOnce(): Promise<void> {
    if (!this.deps.alerts.enabled) return;
    if (this.isPaused()) return;
    const nowMs = this.now();
    for (let index = 0; index < this.deps.alerts.rules.length; index++) {
      const rule = this.deps.alerts.rules[index];
      if (rule === undefined || rule.type !== 'metric-threshold') continue;
      let outcome: { crosses: boolean; value: number } | null;
      try {
        outcome = await this.measure(rule);
      } catch (error: unknown) {
        this.logger(`Telescope alert rule '${rule.metric}' failed: ${asMessage(error)}`);
        continue;
      }
      // `null` ⇒ not enough data to decide — leave the current state untouched
      // (a quiet window neither raises nor spuriously resolves a real alert).
      if (outcome === null) continue;
      const isActive = this.active.has(index);
      if (outcome.crosses) {
        if (isActive) continue; // dedup: already firing.
        if (this.inCooldown(index, nowMs)) continue; // flap control after a resolve.
        this.active.add(index);
        await this.dispatch(this.buildPayload(rule, outcome.value, 'firing', nowMs));
      } else {
        if (!isActive) continue; // nothing to resolve.
        this.active.delete(index);
        this.lastResolvedAt.set(index, nowMs);
        await this.dispatch(this.buildPayload(rule, outcome.value, 'resolved', nowMs));
      }
    }
  }

  private inCooldown(index: number, nowMs: number): boolean {
    const last = this.lastResolvedAt.get(index);
    if (last === undefined) return false;
    return nowMs - last < this.deps.alerts.cooldownMs;
  }

  /**
   * Compute the rule's metric over its window and decide whether it crosses in the
   * comparator direction. Returns `null` when the metric can't be evaluated (no
   * samples, or below `minSamples` for a percentile/ratio rule) so the caller
   * leaves the alert state unchanged.
   */
  private async measure(
    rule: MetricThresholdRule,
  ): Promise<{ crosses: boolean; value: number } | null> {
    const computed = await this.computeMetric(rule.metric, rule.window);
    if (computed === null) return null;
    // `minSamples` guards noisy percentile/ratio pages; a raw count of 0 is a real
    // value that must be able to auto-resolve a firing spike, so it bypasses it.
    if (rule.metric !== 'exception-count' && computed.samples < (rule.minSamples ?? 1)) {
      return null;
    }
    const crosses =
      rule.comparator === 'gte'
        ? computed.value >= rule.threshold
        : computed.value <= rule.threshold;
    return { crosses, value: computed.value };
  }

  /**
   * Aggregate a single metric over `window` via the injected {@link MetricSource}
   * — reusing the exact `summarizeStats`/`percentile` computation behind the
   * dashboard. Returns `{ value, samples }`, or `null` when there is no data to
   * compute a percentile/ratio from (`exception-count` never returns `null`; a
   * count of 0 is valid).
   */
  private async computeMetric(
    metric: AlertMetric,
    window: string,
  ): Promise<{ value: number; samples: number } | null> {
    const windowMs = durationToMs(window);
    if (metric === 'cache-hit-rate') {
      const stats = await this.deps.metrics.getStats({ type: EntryType.Cache, windowMs });
      const cache = stats.cache;
      if (cache === undefined) return null;
      const samples = cache.hits + cache.misses;
      if (samples === 0) return null;
      return { value: cache.hitRatio, samples };
    }
    if (metric === 'exception-count') {
      const stats = await this.deps.metrics.getStats({ type: EntryType.Exception, windowMs });
      return { value: stats.total, samples: stats.total };
    }
    // Latency percentile metrics reuse `summarizeStats`' latency block.
    const type = metric.startsWith('request') ? EntryType.Request : EntryType.Query;
    const stats = await this.deps.metrics.getStats({ type, windowMs });
    const latency = stats.latency;
    if (latency === undefined) return null;
    const value = metric.endsWith('p99-ms') ? latency.p99 : latency.p95;
    return { value, samples: latency.count };
  }

  private buildPayload(
    rule: MetricThresholdRule,
    value: number,
    status: 'firing' | 'resolved',
    nowMs: number,
  ): AlertPayload {
    return {
      rule,
      value,
      threshold: rule.threshold,
      firedAt: new Date(nowMs).toISOString(),
      instanceId: this.deps.alerts.instanceId,
      status,
      metric: rule.metric,
      ...(this.deps.alerts.dashboardUrl !== null
        ? { dashboardUrl: this.deps.alerts.dashboardUrl }
        : {}),
    };
  }

  /**
   * Fan the payload out to every channel concurrently. Each channel's failure is
   * isolated (`Promise.allSettled`) and warn-logged ONCE per channel name so a
   * persistently-down destination doesn't flood the logs. Never rejects.
   */
  private async dispatch(payload: AlertPayload): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.alerts.channels.map((channel) => channel.send(payload)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.warnChannelFailure(this.deps.alerts.channels[index], result.reason);
      }
    });
  }

  private warnChannelFailure(channel: AlertChannel | undefined, reason: unknown): void {
    if (channel === undefined) return;
    if (this.warnedChannels.has(channel.name)) return;
    this.warnedChannels.add(channel.name);
    this.logger(`Telescope alert channel '${channel.name}' failed: ${asMessage(reason)}`);
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
