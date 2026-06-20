import type { Diagnosis } from './diagnoser.js';

/** Default cap on cached diagnoses. Bounds memory regardless of error variety. */
const DEFAULT_MAX_ENTRIES = 500;

/** Default time a cached diagnosis stays fresh: 24h. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  diagnosis: Diagnosis;
  storedAt: number;
}

/**
 * The pluggable cache contract a diagnoser reads/writes through, keyed by
 * exception family hash. A host can swap in a Redis- or DB-backed implementation
 * for cross-process sharing; the default is the in-memory LRU below.
 */
export interface DiagnosisStore {
  get(familyHash: string): Diagnosis | null;
  set(familyHash: string, diagnosis: Diagnosis): void;
}

/**
 * Bounded, TTL'd, in-process LRU cache of AI diagnoses keyed by exception
 * `familyHash`. A family is diagnosed ONCE then served from here, so re-diagnosing
 * the same error never burns model tokens.
 *
 * Eviction is insertion-order (`Map` iteration): at the cap the OLDEST inserted
 * entry is dropped, and a re-set entry moves to the end (LRU-on-write). TTL is
 * checked lazily on read (an expired hit is a miss and is deleted), so stale
 * entries don't linger as false "cached" results.
 */
export class DiagnosisCache implements DiagnosisStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: { maxEntries?: number; ttlMs?: number; now?: () => number }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  /** The cached diagnosis for `familyHash`, or `null` on a miss / expiry. */
  get(familyHash: string): Diagnosis | null {
    const entry = this.entries.get(familyHash);
    if (entry === undefined) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(familyHash);
      return null;
    }
    // Refresh recency so genuinely-cold entries are the ones evicted at the cap.
    this.entries.delete(familyHash);
    this.entries.set(familyHash, entry);
    return entry.diagnosis;
  }

  /** Store (or refresh) the diagnosis for `familyHash`, evicting if over cap. */
  set(familyHash: string, diagnosis: Diagnosis): void {
    this.entries.delete(familyHash);
    this.entries.set(familyHash, { diagnosis, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Number of live entries (test/observability seam; does not evict expired). */
  get size(): number {
    return this.entries.size;
  }
}

export {
  DEFAULT_MAX_ENTRIES as DEFAULT_DIAGNOSIS_CACHE_MAX,
  DEFAULT_TTL_MS as DEFAULT_DIAGNOSIS_TTL_MS,
};
