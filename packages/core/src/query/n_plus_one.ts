import { type Entry, EntryType } from '../entry.js';

/** A flat family-count N+1 insight — "query template X ran N times". */
export interface NPlusOneInsight {
  familyHash: string;
  count: number;
  sql: string;
}

/** Extract the `sql` string from a query entry's content, or `''`. */
function sqlOf(entry: Entry): string {
  const record =
    typeof entry.content === 'object' && entry.content !== null
      ? (entry.content as Record<string, unknown>)
      : null;
  return record !== null && typeof record.sql === 'string' ? record.sql : '';
}

/**
 * Flat N+1 detection — ported from `nestjs-telescope`'s `query/n-plus-one.ts`.
 * Group query entries by `familyHash`; report templates that ran `>= threshold`
 * times. Pure; order follows insertion (first-seen family first).
 */
export function detectNPlusOne(entries: Entry[], threshold: number): NPlusOneInsight[] {
  const groups = new Map<string, { count: number; sql: string }>();
  for (const entry of entries) {
    if (entry.type !== EntryType.Query || entry.familyHash === null) continue;
    const existing = groups.get(entry.familyHash);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(entry.familyHash, { count: 1, sql: sqlOf(entry) });
    }
  }
  const insights: NPlusOneInsight[] = [];
  for (const [familyHash, group] of groups) {
    if (group.count >= threshold) {
      insights.push({ familyHash, count: group.count, sql: group.sql });
    }
  }
  return insights;
}

/**
 * A detected N+1 LOOP pattern within a single request/trace: one driving "parent"
 * query (the SELECT that produced the rows being iterated) followed by N
 * similarly-shaped "child" queries (the per-row lookups). Richer than the flat
 * {@link detectNPlusOne} family-count: it attributes a likely parent and weights
 * by the total time WASTED in the loop, so the worst offenders rank first.
 */
export interface NPlusOnePattern {
  /** The repeated child query's family hash. */
  childFamilyHash: string;
  /** A representative child SQL (template/text). */
  childSql: string;
  /** How many times the child query ran in the trace (>= threshold). */
  count: number;
  /** Sum of the child queries' durations (ms) — the "wasted" time, the rank key. */
  totalDurationMs: number;
  /**
   * The family hash of the query that most likely drove the loop — the distinct
   * query immediately preceding the loop in record order — or `null` when the
   * loop is the first thing in the trace (no identifiable parent).
   */
  parentFamilyHash: string | null;
  /** The likely-parent SQL, or `null` when there is no identifiable parent. */
  parentSql: string | null;
  /** A representative child entry id (deep-link / hydration seam). */
  representativeId: string;
  /** The trace the pattern was found in. */
  traceId: string;
}

export interface NPlusOnePatternOptions {
  /** Minimum repetitions of one child template to flag a loop. */
  threshold: number;
}

interface ChildGroup {
  count: number;
  totalDurationMs: number;
  representativeId: string;
  sql: string;
  /** Record-order index of the FIRST occurrence (to find the driving parent). */
  firstIndex: number;
}

/**
 * Detect N+1 loop patterns in a request/trace's query entries. Ported from
 * `nestjs-telescope`'s `query/n-plus-one-pattern.ts` (NestJS `batchId` becomes
 * Adonis `traceId`). For each query family that repeats `>= threshold` times we
 * emit a pattern weighted by the loop's total duration and attribute the likely
 * driving parent (the distinct query that ran just before the loop began). Pure;
 * ordered by total wasted duration desc.
 *
 * NOTE: callers pass entries in OLDEST-FIRST record order (ascending sequence) so
 * "the query immediately preceding the loop" is meaningful. The store returns
 * newest-first, so the service reverses before calling.
 */
export function detectNPlusOnePatterns(
  entries: Entry[],
  options: NPlusOnePatternOptions,
): NPlusOnePattern[] {
  const queries = entries.filter(
    (entry) => entry.type === EntryType.Query && entry.familyHash !== null,
  );

  const groups = new Map<string, ChildGroup>();
  queries.forEach((entry, index) => {
    const familyHash = entry.familyHash as string;
    const duration = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
    const existing = groups.get(familyHash);
    if (existing) {
      existing.count += 1;
      existing.totalDurationMs += duration;
    } else {
      groups.set(familyHash, {
        count: 1,
        totalDurationMs: duration,
        representativeId: entry.id,
        sql: sqlOf(entry),
        firstIndex: index,
      });
    }
  });

  const patterns: NPlusOnePattern[] = [];
  for (const [childFamilyHash, group] of groups) {
    if (group.count < options.threshold) continue;
    const parent = findParent(queries, group.firstIndex, childFamilyHash);
    patterns.push({
      childFamilyHash,
      childSql: group.sql,
      count: group.count,
      totalDurationMs: group.totalDurationMs,
      parentFamilyHash: parent?.familyHash ?? null,
      parentSql: parent === null ? null : sqlOf(parent),
      representativeId: group.representativeId,
      traceId: queries[group.firstIndex]?.traceId ?? '',
    });
  }

  return patterns.sort(
    (a, b) =>
      b.totalDurationMs - a.totalDurationMs ||
      b.count - a.count ||
      a.childFamilyHash.localeCompare(b.childFamilyHash),
  );
}

/**
 * The likely driving parent for a loop whose first child is at `firstIndex`:
 * walking BACKWARDS from just before the loop, the first query of a DIFFERENT
 * family. Returns `null` when none precedes it (the loop is the trace's start).
 */
function findParent(queries: Entry[], firstIndex: number, childFamilyHash: string): Entry | null {
  for (let i = firstIndex - 1; i >= 0; i--) {
    const candidate = queries[i];
    if (candidate !== undefined && candidate.familyHash !== childFamilyHash) {
      return candidate;
    }
  }
  return null;
}
