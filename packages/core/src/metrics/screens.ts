import { type Entry, EntryType } from '../entry.js';
import type { RequestEntryContent, RequestKind } from '../request_watcher.js';

/** One route's traffic over the window. */
export interface ScreenStats {
  /** The request path, e.g. `/pesquisador/escrita`. */
  url: string;
  /** How the route was reached — `page`, `api` or `asset`. */
  kind: RequestKind;
  /** How many requests hit it. */
  count: number;
  /** Distinct authenticated users who hit it (`0` when nobody was identified). */
  users: number;
  /** Mean duration in ms across the window, rounded. */
  avgMs: number;
  /** Slowest single request in the window, rounded. */
  maxMs: number;
  /** How many responded 4xx/5xx. */
  errors: number;
  /** Most recent hit, ISO. */
  lastAt: string;
}

export interface SummarizeScreensOptions {
  /** Only this kind. Omit for all. */
  kind?: RequestKind;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

interface Accumulator {
  url: string;
  kind: RequestKind;
  count: number;
  users: Set<string>;
  totalMs: number;
  maxMs: number;
  errors: number;
  lastAt: number;
}

/**
 * Group `request` entries by url into per-route traffic.
 *
 * Grouping is by (url, kind) and not url alone: the same path can legitimately be
 * both — a page visit to `/relatorios` and the Inertia partial reload of it — and
 * merging them would report one number that answers neither "how many people opened
 * this screen" nor "how hard is this endpoint being hit".
 *
 * Entries recorded before `kind` existed are treated as `api`, which is what the
 * majority of unclassified traffic is; they age out with retention.
 *
 * Pure.
 */
export function summarizeScreens(
  entries: Entry[],
  options: SummarizeScreensOptions = {},
): ScreenStats[] {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const byRoute = new Map<string, Accumulator>();

  for (const entry of entries) {
    if (entry.type !== EntryType.Request) continue;
    const content = entry.content as RequestEntryContent | undefined;
    if (content === undefined || typeof content.url !== 'string') continue;

    const kind = content.kind ?? 'api';
    if (options.kind !== undefined && kind !== options.kind) continue;

    const key = `${kind} ${content.url}`;
    const at = entry.createdAt.getTime();
    let acc = byRoute.get(key);
    if (acc === undefined) {
      acc = {
        url: content.url,
        kind,
        count: 0,
        users: new Set<string>(),
        totalMs: 0,
        maxMs: 0,
        errors: 0,
        lastAt: at,
      };
      byRoute.set(key, acc);
    }

    acc.count += 1;
    if (content.user?.id) acc.users.add(content.user.id);
    const durationMs = typeof content.durationMs === 'number' ? content.durationMs : 0;
    acc.totalMs += durationMs;
    if (durationMs > acc.maxMs) acc.maxMs = durationMs;
    if (typeof content.status === 'number' && content.status >= 400) acc.errors += 1;
    if (at > acc.lastAt) acc.lastAt = at;
  }

  return [...byRoute.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((acc) => ({
      url: acc.url,
      kind: acc.kind,
      count: acc.count,
      users: acc.users.size,
      avgMs: Math.round(acc.totalMs / acc.count),
      maxMs: Math.round(acc.maxMs),
      errors: acc.errors,
      lastAt: new Date(acc.lastAt).toISOString(),
    }));
}
