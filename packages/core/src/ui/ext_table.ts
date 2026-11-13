import type { OffsetPage, OffsetPageMeta } from '@adonis-agora/filter';

/**
 * Pure helpers for the paged extension-dashboard table: the pagination math and the deep-link
 * templating a dashboard renders a `{ kind: 'table', paged: true }` panel with. Kept framework-free
 * and side-effect-free so the logic is unit-tested directly and any front end (the
 * `@adonis-agora/telescope-ui` console, or one of your own over the JSON API) can share it.
 */

/**
 * The provider payload for a `{ kind: 'table', paged: true }` panel — the offset list envelope
 * every `@adonis-agora/*` list endpoint answers with: `{ data: rows, meta: { total, perPage,
 * currentPage, lastPage, firstPage } }`. Build it with `offsetPage(rows, { total, page, size })`
 * from `@adonis-agora/filter`, from the `page`/`size` the panel's query carries.
 */
export type PagedTableData = OffsetPage<Record<string, unknown>>;

/** The pager state the UI renders from a {@link PagedTableData} payload. */
export interface TablePagination {
  /** Current 1-based page (clamped to >= 1). */
  page: number;
  /** Page size (rows-per-page). */
  size: number;
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
 * Normalize a paged provider payload into pager state: clamp the page to >= 1, fall back to the
 * row count when `meta` is incomplete (so a provider answering only `data` still renders one page),
 * and compute prev/next availability.
 */
export function tablePagination(page: {
  data?: unknown[];
  meta?: Partial<OffsetPageMeta>;
}): TablePagination {
  const rows = page.data ?? [];
  const meta = page.meta ?? {};
  const current = Math.max(1, meta.currentPage ?? 1);
  const size = meta.perPage && meta.perPage > 0 ? meta.perPage : rows.length || 1;
  const total = meta.total ?? rows.length;
  const totalPages = Math.max(1, meta.lastPage ?? Math.ceil(total / size));
  return {
    page: current,
    size,
    total,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
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
