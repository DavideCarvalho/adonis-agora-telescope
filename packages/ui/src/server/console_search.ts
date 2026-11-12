import type { AgoraConsoleSearchHit } from './console_switcher.js';

/** The slice of a telescope store the search reads (structural). */
export interface SearchableStore {
  get(id: string): Promise<SearchableEntry | null>;
  list(query: { search?: string; traceId?: string; size?: number }): Promise<SearchableEntry[]>;
}

/** The slice of an entry a hit is built from. */
export interface SearchableEntry {
  id: string;
  type: string;
  traceId: string | null;
  content: unknown;
  createdAt: Date | string;
}

/** A one-line description of an entry (`GET /checkout → 500`, `Error: boom`, the SQL…). */
export function entryTitle(entry: SearchableEntry): string {
  const c = (entry.content ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));
  switch (entry.type) {
    case 'request':
      return `${text(c.method)} ${text(c.url)} → ${text(c.status)}`.trim();
    case 'query':
      return text(c.sql).slice(0, 120) || 'query';
    case 'exception':
    case 'client_exception':
      return `${text(c.name ?? c.class)}: ${text(c.message)}`.slice(0, 160);
    case 'log':
      return `${text(c.level)}: ${text(c.message)}`.slice(0, 160);
    case 'job':
      return `${text(c.name)} (${text(c.status)})`;
    case 'diagnostic':
      return `${text(c.lib)}:${text(c.event)}`;
    default:
      return entry.type;
  }
}

function subtitle(entry: SearchableEntry): string {
  const at =
    entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt);
  return `${entry.type} · ${at}`;
}

/**
 * Telescope's search provider for the console switcher: an entry id or a trace id opens it
 * directly; anything else searches entry content and tags (newest first).
 */
export function telescopeConsoleSearch(
  getStore: () => SearchableStore | null,
  mount: string,
): (ctx: unknown, query: string, limit: number) => Promise<AgoraConsoleSearchHit[]> {
  const shell = mount === '/' ? '/' : mount;
  const entryHref = (id: string) => `${shell}#/entries/${encodeURIComponent(id)}`;
  return async (_ctx, query, limit) => {
    const store = getStore();
    if (store === null) return [];
    const q = query.trim();
    const hits: AgoraConsoleSearchHit[] = [];
    const seen = new Set<string>();

    const exact = await store.get(q).catch(() => null);
    if (exact !== null) {
      hits.push({ title: entryTitle(exact), subtitle: subtitle(exact), href: entryHref(exact.id) });
      seen.add(exact.id);
    }
    const trace = await store.list({ traceId: q, size: 1 }).catch(() => []);
    if (trace.length > 0) {
      hits.push({
        title: `Trace ${q}`,
        subtitle: 'trace waterfall',
        href: `${shell}#/traces/${encodeURIComponent(q)}`,
      });
    }
    if (q.length >= 2 && hits.length < limit) {
      const found = await store.list({ search: q, size: limit }).catch(() => []);
      for (const entry of found) {
        if (hits.length >= limit) break;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        hits.push({
          title: entryTitle(entry),
          subtitle: subtitle(entry),
          href: entryHref(entry.id),
        });
      }
    }
    return hits.slice(0, limit);
  };
}
