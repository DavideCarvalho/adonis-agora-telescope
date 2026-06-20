/**
 * Default cap on tracked error families. The map is the ONLY state the
 * `new-exception` rule keeps, and it must stay bounded so a host that throws a
 * long tail of unique error families (e.g. message-embedded ids that defeat the
 * family hash) can never grow it without limit. At the cap we evict the OLDEST
 * inserted family — the one least likely to still be "recently seen" — which is
 * the correct bias for a recency-window dedup.
 */
const DEFAULT_MAX_FAMILIES = 10_000;

/**
 * Bounded, in-memory "have we seen this error family recently?" tracker backing
 * the `new-exception` rule. Per-process by design: it lives in process memory, so
 * in a multi-replica deployment the SAME family may be reported as new once per
 * pod (documented caveat — acceptable for v1).
 *
 * Eviction uses a `Map`'s insertion-order iteration: the first key is the oldest
 * INSERTED entry. The window check already discards stale last-seen times, so
 * insertion-order eviction is a sound, O(1) cap with no per-touch bookkeeping.
 *
 * Ported verbatim from the aviary telescope core.
 */
export class NewExceptionTracker {
  private readonly seen = new Map<string, number>();
  private readonly maxFamilies: number;

  constructor(maxFamilies: number = DEFAULT_MAX_FAMILIES) {
    this.maxFamilies = maxFamilies;
  }

  /**
   * Record an observation of `familyHash` at `nowMs` and report whether this is a
   * NEW family for the `windowMs` window — i.e. it was either never seen or last
   * seen longer ago than the window (the "re-occurring after being resolved"
   * signal). Always updates the stored last-seen time so repeat occurrences
   * refresh the window. Returns `true` only on a genuine first/expired occurrence
   * (the signal that should fire the alert).
   */
  observe(familyHash: string, nowMs: number, windowMs: number): boolean {
    const lastSeen = this.seen.get(familyHash);
    const isNew = lastSeen === undefined || nowMs - lastSeen >= windowMs;
    // Delete-then-set so a refreshed family moves to the END of insertion order,
    // keeping genuinely-oldest families at the front for eviction.
    this.seen.delete(familyHash);
    this.seen.set(familyHash, nowMs);
    this.evictIfNeeded();
    return isNew;
  }

  /**
   * Forget `familyHash` entirely, so its NEXT occurrence is reported as new again.
   * This is the explicit "resolve" hook: after an operator marks a family resolved
   * (or a self-heal job clears it), the very next occurrence pages again without
   * waiting for the window to elapse.
   */
  resolve(familyHash: string): void {
    this.seen.delete(familyHash);
  }

  /** Forget every tracked family. */
  clear(): void {
    this.seen.clear();
  }

  /** Number of tracked families (test/observability seam). */
  get size(): number {
    return this.seen.size;
  }

  /** Evict the oldest entries until the map is within its cap. */
  private evictIfNeeded(): void {
    while (this.seen.size > this.maxFamilies) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

export { DEFAULT_MAX_FAMILIES };
