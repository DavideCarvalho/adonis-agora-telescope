import {
  applyCustomFilter,
  BaseFilter,
  type CursorPageResponse,
  cursorPage,
  decodeCursor,
  encodeCursor,
  InvalidColumnFilterError,
  parseCursorParams,
  parseFilterRequest,
  resolveSort,
} from '@adonis-agora/filter';
import type { Entry } from '../entry.js';
import type { EntryQuery } from '../store.js';
import { compareNewestFirst } from '../stores/parquet_format.js';

/** Default page size (`first`) of the entry feeds when the request sends none. */
export const DEFAULT_LIST_SIZE = 50;
/** Largest page size (`first`) an entry feed serves; bigger requests are clamped. */
export const MAX_LIST_SIZE = 500;

/**
 * The {@link EntryQuery} an {@link EntryFilter} fills in. The store resolves it; the filter only
 * narrows named predicates, and anything the store cannot express is refused at dispatch.
 */
export class EntryQueryDraft {
  readonly query: EntryQuery = {};

  /** Narrow by one or more predicates. Later calls overwrite the same field. */
  narrow(patch: EntryQuery): void {
    Object.assign(this.query, patch);
  }
}

/** A repeated param arrives as an array, a comma list as `a,b`; both mean a list. Blanks drop. */
function values(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  return raw
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v).trim())
    .filter((v) => v !== '');
}

/** Operators a set-valued field accepts: one value narrows, several match ANY of them. */
const SET_OPERATORS = new Set(['equals', 'in', 'isAnyOf']);

function assertSetOperator(field: string, operator: string): void {
  if (!SET_OPERATORS.has(operator)) {
    throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
  }
}

/** One value only: the store narrows by a single value of this field. */
function single(field: string, value: unknown, operator: string): string | undefined {
  assertSetOperator(field, operator);
  const list = values(value);
  if (list.length > 1) {
    throw new InvalidColumnFilterError(`"${field}" accepts one value.`);
  }
  return list[0];
}

/** An instant from the wire: an ISO-8601 string or epoch milliseconds. */
function instant(field: string, value: unknown): Date {
  const text = String(value).trim();
  const asNumber = Number(text);
  const date =
    text !== '' && Number.isFinite(asNumber) ? new Date(asNumber) : new Date(Date.parse(text));
  if (Number.isNaN(date.getTime())) {
    throw new InvalidColumnFilterError(`"${field}" needs a date (ISO-8601 or epoch ms).`);
  }
  return date;
}

/** The later of two lower bounds / earlier of two upper bounds, so two range filters AND. */
const later = (a: Date | undefined, b: Date) => (a === undefined || b > a ? b : a);
const earlier = (a: Date | undefined, b: Date) => (a === undefined || b < a ? b : a);

/**
 * The entry feeds' filter: one method per filterable field, narrowing an {@link EntryQueryDraft}.
 * Driven by `applyCustomFilter`, so `filter[type]=request`, `filter[tag][]=a&filter[tag][]=b`,
 * `filter[createdAt][gte]=2026-01-01` all land here; an unknown field or an operator a field does
 * not support throws `InvalidColumnFilterError` (a `400`).
 */
export class EntryFilter extends BaseFilter<EntryQueryDraft> {
  declare $query: EntryQueryDraft;

  /** One entry type (`request`, `query`, `exception`, …). */
  type(value: unknown, operator: string): void {
    const type = single('type', value, operator);
    if (type !== undefined) this.$query.narrow({ type });
  }

  /** One tag narrows to entries carrying it; several match entries carrying ANY of them. */
  tag(value: unknown, operator: string): void {
    assertSetOperator('tag', operator);
    const tags = values(value);
    if (tags.length === 0) return;
    this.$query.narrow(tags.length === 1 ? { tag: tags[0] as string } : { anyTags: tags });
  }

  /** One trace narrows to its entries; several match entries of ANY of them. */
  traceId(value: unknown, operator: string): void {
    assertSetOperator('traceId', operator);
    const ids = values(value);
    if (ids.length === 0) return;
    this.$query.narrow(ids.length === 1 ? { traceId: ids[0] as string } : { traceIds: ids });
  }

  /** One grouping key (the exception family, the normalized query, …). */
  familyHash(value: unknown, operator: string): void {
    const familyHash = single('familyHash', value, operator);
    if (familyHash !== undefined) this.$query.narrow({ familyHash });
  }

  /** A time range: `lt`/`lte`/`gt`/`gte`/`between` on when the entry was recorded. */
  createdAt(value: unknown, operator: string): void {
    const q = this.$query.query;
    switch (operator) {
      case 'lt':
        q.before = earlier(q.before, instant('createdAt', value));
        return;
      case 'lte':
        q.before = earlier(q.before, new Date(instant('createdAt', value).getTime() + 1));
        return;
      case 'gt':
        q.after = later(q.after, instant('createdAt', value));
        return;
      case 'gte':
        q.after = later(q.after, new Date(instant('createdAt', value).getTime() - 1));
        return;
      case 'between': {
        const [from, to] = values(value);
        if (from === undefined || to === undefined) {
          throw new InvalidColumnFilterError('"createdAt" between needs two dates.');
        }
        q.after = later(q.after, new Date(instant('createdAt', from).getTime() - 1));
        q.before = earlier(q.before, new Date(instant('createdAt', to).getTime() + 1));
        return;
      }
      default:
        throw new InvalidColumnFilterError(
          `"createdAt" does not support the "${operator}" operator.`,
        );
    }
  }
}

/** A filter with no fields: any `filter[...]` sent to an endpoint that has none is a `400`. */
export class NoFilter extends BaseFilter<EntryQueryDraft> {}

/** The position just past a row of an entry feed, in its newest-first order. */
interface EntryBoundary {
  createdAtMs: number;
  sequence: number;
  id: string;
}

/** Opaque cursor for the position just past `entry` in a newest-first feed. */
export function encodeEntryCursor(entry: Entry): string {
  return encodeCursor(['e', entry.createdAt.getTime(), entry.sequence, entry.id]);
}

function decodeEntryCursor(cursor: string): EntryBoundary {
  const values = decodeCursor(cursor);
  if (
    values === null ||
    values[0] !== 'e' ||
    typeof values[1] !== 'number' ||
    typeof values[2] !== 'number' ||
    typeof values[3] !== 'string'
  ) {
    throw new InvalidColumnFilterError('Invalid cursor.');
  }
  return { createdAtMs: values[1], sequence: values[2], id: values[3] };
}

/** Whether `entry` sorts strictly after (older than) the boundary in newest-first order. */
function isPast(entry: Entry, boundary: EntryBoundary): boolean {
  const ms = entry.createdAt.getTime();
  if (ms !== boundary.createdAtMs) return ms < boundary.createdAtMs;
  if (entry.sequence !== boundary.sequence) return entry.sequence < boundary.sequence;
  return entry.id < boundary.id;
}

/** A parsed request for one of the entry feeds. */
export interface EntryListRequest {
  /** The store query the filters and `search` built (no paging fields). */
  query: EntryQuery;
  /** Page size (`first`). */
  size: number;
  /** Position to continue after (the decoded `after` cursor), absent on the first page. */
  after?: EntryBoundary;
}

/** Options for {@link parseEntryListRequest}. */
export interface EntryListOptions {
  /** Filter class to dispatch `filter[...]` to. Default {@link EntryFilter}. */
  filter?: typeof EntryFilter | typeof NoFilter;
  /** Default page size. Default {@link DEFAULT_LIST_SIZE}. */
  defaultSize?: number;
}

/**
 * Read an entry feed's query string: `filter[...]` (through {@link EntryFilter}), `search`,
 * `sort` (only `-createdAt`, the feed's one order), and cursor paging (`after` + `first`).
 *
 * The feeds page FORWARD only (newest first): the stores seek by time downwards, so there is no
 * `before`/`last`. A client walks back through the cursors it already visited.
 *
 * Throws `InvalidColumnFilterError` (map it to `400`) for an unknown filter field or operator, a
 * sort other than `-createdAt`, a `before` cursor, or a malformed cursor.
 */
export async function parseEntryListRequest(
  qs: Record<string, unknown>,
  options: EntryListOptions = {},
): Promise<EntryListRequest> {
  const input = parseFilterRequest(qs);
  resolveSort(input.sort, { sortable: ['createdAt'], default: '-createdAt' }).forEach((item) => {
    if (item.direction !== 'desc') {
      throw new InvalidColumnFilterError('This feed is ordered newest first: sort=-createdAt.');
    }
  });

  const draft = new EntryQueryDraft();
  await applyCustomFilter(
    draft,
    options.filter ?? EntryFilter,
    { request: { qs: () => qs } },
    {
      input,
    },
  );
  const query = draft.query;
  if (input.search !== undefined && input.search.trim() !== '') query.search = input.search.trim();

  const paging = parseCursorParams(qs, {
    defaultSize: options.defaultSize ?? DEFAULT_LIST_SIZE,
    maxSize: MAX_LIST_SIZE,
  });
  if (paging.backward) {
    throw new InvalidColumnFilterError(
      'This feed pages forward only (newest first): use `after` with `meta.nextCursor`.',
    );
  }
  return {
    query,
    size: paging.size,
    ...(paging.after !== undefined ? { after: decodeEntryCursor(paging.after) } : {}),
  };
}

/** Rows the first read asks for beyond the page, to absorb same-instant ties at the edges. */
const TIE_SLACK = 16;
/** Past this read size, a pile of same-instant entries is served best-effort instead of growing. */
const MAX_READ = 20_000;

/**
 * One forward page of a newest-first feed: the `size` entries just past `after` (or the newest
 * `size`), plus whether more follow.
 *
 * The stores seek by time (`before`), and several entries can share an instant, so the read starts
 * at the cursor's instant (inclusive) and drops the rows at or before the cursor position. Rows
 * sharing the instant of the last row read may be cut off by the store's limit, so only rows newer
 * than that instant count as settled; when that is not enough, the read grows.
 */
export async function readEntryPage(
  list: (query: EntryQuery) => Promise<Entry[]>,
  request: EntryListRequest,
): Promise<{ rows: Entry[]; nextCursor: string | null }> {
  const { query, size, after } = request;
  const want = size + 1;
  let before = query.before;
  if (after !== undefined) {
    const ceiling = new Date(after.createdAtMs + 1);
    if (before === undefined || ceiling < before) before = ceiling;
  }
  let limit = want + TIE_SLACK;
  let rows: Entry[];
  for (;;) {
    const batch = await list({
      ...query,
      ...(before !== undefined ? { before } : {}),
      size: limit,
    });
    const past = after === undefined ? batch : batch.filter((e) => isPast(e, after));
    if (batch.length < limit || limit >= MAX_READ) {
      rows = past.sort(compareNewestFirst);
      break;
    }
    const lastMs = batch[batch.length - 1]?.createdAt.getTime() ?? 0;
    const settled = past.filter((e) => e.createdAt.getTime() > lastMs);
    if (settled.length >= want) {
      rows = settled.sort(compareNewestFirst);
      break;
    }
    limit = Math.min(limit * 2, MAX_READ);
  }
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > size && last !== undefined ? encodeEntryCursor(last) : null,
  };
}

/** Wrap a forward page of an entry feed in the cursor envelope. */
export function entryFeedPage<T>(rows: T[], nextCursor: string | null): CursorPageResponse<T> {
  return cursorPage(rows, {
    nextCursor,
    prevCursor: null,
    hasNext: nextCursor !== null,
    hasPrev: false,
  });
}

// ─── traces: an opaque offset cursor ─────────────────────────────────────────

/**
 * Cursor paging over the traces list. A trace's "last seen" moves while it is being read, so a
 * keyset over it would skip or repeat traces; the cursor carries the position in the list instead,
 * which also lets it page backward.
 */
export interface TraceListRequest {
  /** Index of the first trace of the page. */
  offset: number;
  /** Page size. */
  size: number;
}

function decodeTraceCursor(cursor: string): number {
  const values = decodeCursor(cursor);
  if (
    values === null ||
    values[0] !== 't' ||
    typeof values[1] !== 'number' ||
    !Number.isInteger(values[1]) ||
    values[1] < 0
  ) {
    throw new InvalidColumnFilterError('Invalid cursor.');
  }
  return values[1];
}

/** Opaque cursor for a position in the traces list. */
export function encodeTraceCursor(offset: number): string {
  return encodeCursor(['t', offset]);
}

/**
 * Read the traces list's query string: cursor paging (`after`/`first` forward, `before`/`last`
 * backward) and `sort` (only `-lastAt`). The list has no filters: any `filter[...]` is a `400`.
 */
export async function parseTraceListRequest(
  qs: Record<string, unknown>,
  defaultSize = DEFAULT_LIST_SIZE,
): Promise<TraceListRequest> {
  const input = parseFilterRequest(qs);
  resolveSort(input.sort, { sortable: ['lastAt'], default: '-lastAt' }).forEach((item) => {
    if (item.direction !== 'desc') {
      throw new InvalidColumnFilterError(
        'Traces are ordered most recently active first: sort=-lastAt.',
      );
    }
  });
  await applyCustomFilter(
    new EntryQueryDraft(),
    NoFilter,
    { request: { qs: () => qs } },
    { input },
  );

  const paging = parseCursorParams(qs, { defaultSize, maxSize: MAX_LIST_SIZE });
  if (paging.before !== undefined) {
    const end = decodeTraceCursor(paging.before);
    const offset = Math.max(0, end - paging.size);
    return { offset, size: end - offset };
  }
  return {
    offset: paging.after !== undefined ? decodeTraceCursor(paging.after) : 0,
    size: paging.size,
  };
}
