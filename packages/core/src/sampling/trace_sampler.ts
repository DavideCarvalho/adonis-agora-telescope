/**
 * Watcher-side sampling that keeps or drops a WHOLE trace: the decision is a pure
 * function of the trace id, so every query (and cache hit) of a kept request is
 * recorded and every one of a dropped request is not. That keeps per-trace views —
 * the request timeline, the N+1 detector — complete for the traces that are kept.
 *
 * Watchers sharing the same rate make the same decision for a trace, and a trace
 * kept at a lower rate is also kept at any higher one (the hash is compared against
 * the rate), so `query.sampleRate: 0.1` + `cache.hitSampleRate: 0.5` keeps the
 * cache hits of every trace whose queries were kept.
 *
 * Without a trace (a query outside any request or job), the decision falls back to
 * `random()`.
 */

/** Clamp a configured rate into 0..1; a bad value must not take the app down at boot. */
export function clampRate(rate: number | undefined): number {
  if (rate === undefined || Number.isNaN(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

/** FNV-1a over the trace id, mapped to [0, 1). Stable across processes and restarts. */
export function traceUnit(traceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Whether an entry sampled at `rate` is kept. `rate` must already be clamped
 * (see {@link clampRate}). Deterministic per `traceId`; random without one.
 */
export function keepByTrace(
  traceId: string | null,
  rate: number,
  random: () => number = Math.random,
): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return (traceId === null ? random() : traceUnit(traceId)) < rate;
}
