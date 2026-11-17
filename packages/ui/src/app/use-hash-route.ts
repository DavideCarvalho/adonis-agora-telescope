import { useCallback, useEffect, useState } from 'react';
import { splitHash, subscribeHashUrl } from '../agora-kit/url-state/hash-url';

/**
 * The SPA's hash-routed navigation state. Sections map to `#/<section>`; the deep links
 * `#/entries/<id>`, `#/traces/<traceId>` and `#/extensions/<dashboardId>` carry a selected
 * record. The `extensions` route's `dashboardId` is `null`-able so the shell can tell "extensions
 * section, no dashboard selected" apart from a specific contributed dashboard.
 */
export type TelescopeRoute =
  | { name: 'overview' }
  | { name: 'pulse' }
  | { name: 'fleet' }
  | { name: 'entries'; type?: string }
  | { name: 'entry'; id: string }
  | { name: 'traces' }
  | { name: 'screens' }
  | { name: 'ai' }
  | { name: 'trace'; traceId: string }
  | { name: 'exceptions' }
  | { name: 'queues' }
  | { name: 'schedules' }
  | { name: 'exports' }
  | { name: 'profiles' }
  | { name: 'extensions'; dashboardId?: string | null };

/** The route every unknown / empty hash resolves to (the app's landing section). */
export const DEFAULT_ROUTE: TelescopeRoute = { name: 'overview' };

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Parse a `window.location.hash` value into a {@link TelescopeRoute}. Pure (no `window` access). */
export function parseHash(hash: string): TelescopeRoute {
  const { path, search: query } = splitHash(hash);
  const parts = path.split('/').filter((segment) => segment !== '');
  const first = parts[0];

  // Only the first segment selects the route; deeper segments carry a detail id where supported,
  // and any extra trailing segments are intentionally ignored.
  switch (first) {
    case 'overview':
      return { name: 'overview' };
    case 'pulse':
      return { name: 'pulse' };
    case 'fleet':
      return { name: 'fleet' };
    case 'traces': {
      const traceId = parts[1];
      return traceId === undefined
        ? { name: 'traces' }
        : { name: 'trace', traceId: decodeSegment(traceId) };
    }
    case 'screens':
      return { name: 'screens' };
    case 'ai':
      return { name: 'ai' };
    case 'exceptions':
      return { name: 'exceptions' };
    case 'queues':
      return { name: 'queues' };
    case 'schedules':
      return { name: 'schedules' };
    case 'exports':
      return { name: 'exports' };
    case 'profiles':
      return { name: 'profiles' };
    case 'entries': {
      const id = parts[1];
      if (id !== undefined) return { name: 'entry', id: decodeSegment(id) };
      if (query) {
        const type = new URLSearchParams(query).get('type');
        return type === null ? { name: 'entries' } : { name: 'entries', type };
      }
      return { name: 'entries' };
    }
    case 'extensions': {
      const dashboardId = parts[1];
      return dashboardId === undefined
        ? { name: 'extensions' }
        : { name: 'extensions', dashboardId: decodeSegment(dashboardId) };
    }
    default:
      return DEFAULT_ROUTE;
  }
}

/** Serialize a {@link TelescopeRoute} back to a `window.location.hash` value. Pure. */
export function formatHash(route: TelescopeRoute): string {
  switch (route.name) {
    case 'entry':
      return `#/entries/${encodeURIComponent(route.id)}`;
    case 'entries':
      return route.type === undefined
        ? '#/entries'
        : `#/entries?type=${encodeURIComponent(route.type)}`;
    case 'trace':
      return `#/traces/${encodeURIComponent(route.traceId)}`;
    case 'extensions':
      return route.dashboardId === undefined || route.dashboardId === null
        ? '#/extensions'
        : `#/extensions/${encodeURIComponent(route.dashboardId)}`;
    default:
      return `#/${route.name}`;
  }
}

function readHash(): TelescopeRoute {
  if (typeof window === 'undefined') return DEFAULT_ROUTE;
  return parseHash(window.location.hash);
}

/**
 * Read the current route from `window.location.hash` (parsed at mount) and keep it in sync with
 * `hashchange` events. `navigate` writes the hash — the URL stays the single source of truth, so
 * deep links, browser back/forward and programmatic navigation all converge on the same state.
 * Defensive against a missing `window` (SSR), mirroring `useLiveTail`.
 */
export function useHashRoute(): {
  route: TelescopeRoute;
  navigate: (route: TelescopeRoute) => void;
} {
  const [route, setRoute] = useState<TelescopeRoute>(() => readHash());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Also follows query-only writes (a page's URL filters, written with `history.replaceState`,
    // fire no `hashchange`): `#/entries?type=query` lights the watcher in the sidebar.
    const onChange = () =>
      setRoute((prev) => {
        const next = parseHash(window.location.hash);
        return formatHash(next) === formatHash(prev) ? prev : next;
      });
    return subscribeHashUrl(onChange);
  }, []);

  const navigate = useCallback((next: TelescopeRoute) => {
    if (typeof window === 'undefined') return;
    const hash = formatHash(next);
    if (window.location.hash === hash) return;
    window.location.hash = hash;
  }, []);

  return { route, navigate };
}
