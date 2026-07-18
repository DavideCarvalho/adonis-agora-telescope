/**
 * Pure helpers for the paged extension-dashboard table. These are the SOURCE OF
 * TRUTH for the pagination math and the deep-link templating that the
 * server-rendered `dashboard.html` mirrors in its inline JS. Kept framework-free
 * and side-effect-free so the logic is unit-tested directly (dashboard.html's
 * inline `<script>` is a static asset that can't import, so it carries a faithful
 * mirror of these two functions).
 */

/**
 * The provider payload for a `{ kind: 'table', paged: true }` panel — the shape
 * a {@link DataProvider} MUST return when the panel opts into paging. `page` /
 * `limit` normally echo the requested `query.page` / `query.limit`; `total` is
 * the full, unpaginated row count so the UI can render "page X of Y".
 */
export interface PagedTableData {
  rows?: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  limit?: number;
}

/** The pager state the UI renders from a {@link PagedTableData} payload. */
export interface TablePagination {
  /** Current 1-based page (clamped to >= 1). */
  page: number;
  /** Rows-per-page used to compute the page count. */
  limit: number;
  /** Full unpaginated row count. */
  total: number;
  /** Number of pages (>= 1). */
  totalPages: number;
  /** Whether a previous page exists (Prev enabled). */
  hasPrev: boolean;
  /** Whether a next page exists (Next enabled). */
  hasNext: boolean;
}

/**
 * Normalize a paged provider payload into pager state: clamp `page` to >= 1,
 * derive `limit`/`total` defensively (so a provider echoing only `rows` still
 * renders one page), and compute `totalPages` + prev/next availability.
 */
export function tablePagination(data: PagedTableData): TablePagination {
  const rows = data.rows ?? [];
  const page = Math.max(1, data.page ?? 1);
  const limit = data.limit && data.limit > 0 ? data.limit : rows.length || 1;
  const total = data.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * Fill a {@link LinkSpec.href} template's `{key}` placeholders from a table row.
 * This is what turns the in-app trace deep-link convention `#/traces/{traceId}`
 * into a concrete `#/traces/abc123` anchor (the same substitution the built-in
 * Entries table uses). A missing key becomes the empty string. Values are
 * URI-encoded so a key containing `#`/`/`/`?` cannot break out of the href.
 */
export function fillLinkHref(href: string, row: Record<string, unknown>): string {
  return href.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = row[key];
    return encodeURIComponent(value == null ? '' : String(value));
  });
}
