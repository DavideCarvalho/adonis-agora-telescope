import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { WINDOWS, type WindowLabel } from './WindowSelect.js';

/**
 * The console's view state in the URL (`#/<page>?<query>`, through the kit's `NuqsHashAdapter`):
 * shared helpers for the params several pages use. Every param drops out of the URL at its
 * default, so a page opened from a plain `#/<page>` link looks exactly as before.
 */

const WINDOW_LABELS = WINDOWS.map((w) => w.label);

/**
 * A trailing time window kept in `?window=<label>` (`5m` … `7d`). Returns the window in ms and a
 * setter taking ms (what `WindowSelect` hands back). Picking a window adds a history entry.
 */
export function useWindowParam(defaultLabel: WindowLabel): [number, (ms: number) => void] {
  const [label, setLabel] = useQueryState(
    'window',
    parseAsStringLiteral(WINDOW_LABELS).withDefault(defaultLabel).withOptions({ history: 'push' }),
  );
  const ms = WINDOWS.find((w) => w.label === label)?.ms ?? 3_600_000;
  const setMs = (next: number) => {
    const match = WINDOWS.find((w) => w.ms === next);
    if (match) void setLabel(match.label);
  };
  return [ms, setMs];
}

/**
 * Keyset pagination in the URL: `?after=<c1>,<c2>` holds the `after` cursor of every page walked
 * so far (page N carries N-1 cursors), so a shared link opens on the same page and back/forward
 * step through pages. Page 1 has no param.
 */
export function useCursorPager(key = 'after') {
  const [cursors, setCursors] = useQueryState(
    key,
    parseAsArrayOf(parseAsString).withDefault([]).withOptions({ history: 'push' }),
  );
  const page = cursors.length + 1;
  return {
    page,
    /** The `after` cursor of the current page (absent on page 1). */
    after: cursors[cursors.length - 1],
    /** A DataTable `onPageChange`: forward pushes `nextCursor`, back pops. */
    onPageChange: (next: number, nextCursor: string | null | undefined) => {
      if (next > page && nextCursor) void setCursors([...cursors, nextCursor]);
      else if (next < page) void setCursors(cursors.slice(0, Math.max(0, next - 1)));
    },
    /** Back to page 1 (a filter changed). */
    reset: () => void setCursors(null),
  };
}

/** A free-text filter kept in `?<key>=`; typing rewrites the current history entry. */
export const searchParam = parseAsString.withDefault('');
