import {
  type ColumnDef,
  flexRender,
  type RowData,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { Button } from './button.js';
import { cn } from './cn.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';

/**
 * No optional features: this console's tables read from an already-filtered,
 * already-paged, already-ordered endpoint, so client-side sorting/filtering row
 * models would only re-derive what the server just decided.
 *
 * Sorting is deliberately absent rather than pending. On a paginated table it would
 * sort the rows ON SCREEN while looking like it sorted the whole table — a wrong
 * answer presented confidently. When a column needs sorting, the endpoint behind it
 * gets an `order` parameter and the sort happens where the data is.
 */
const features = tableFeatures({});

/**
 * Server-driven pagination state. The page NUMBER lives with the caller (usually in
 * the URL hash), not here, so a reload or a shared link lands on the same page.
 */
export interface DataTablePagination {
  /** 1-based current page. */
  page: number;
  onPageChange: (page: number) => void;
  /** Whether a next page exists. Endpoints answer this with one extra row rather
   *  than a COUNT — see the traces endpoint for why. */
  hasMore: boolean;
  /** Dims the pager while a page is in flight, so a double click can't skip a page. */
  isFetching?: boolean;
}

export interface DataTableProps<TRow extends RowData> {
  /** Stable id for the table instance (v9 requires one). */
  id: string;
  data: TRow[];
  // biome-ignore lint/suspicious/noExplicitAny: ColumnDef's value type varies per column.
  columns: Array<ColumnDef<typeof features, TRow, any>>;
  /**
   * Turns on SERVER pagination. The only kind that helps here: TanStack's own
   * pagination row model slices rows that were already fetched, so it would page a
   * list the server had already paid to build. Omit for a table that simply shows
   * everything it is handed.
   */
  pagination?: DataTablePagination;
  /** Stable row key. Falls back to the row index when omitted. */
  rowKey?: (row: TRow, index: number) => string;
  onRowClick?: (row: TRow) => void;
  rowClassName?: (row: TRow) => string | undefined;
  /** Shown in place of the body when there are no rows. */
  empty?: React.ReactNode;
}

/**
 * The one table in this console. Wraps TanStack Table over the vendored shadcn
 * primitives, so every screen gets the same header/row/cell markup and the same
 * Prev/Next pager instead of each section hand-rolling its own.
 */
export function DataTable<TRow extends RowData>({
  id,
  data,
  columns,
  pagination,
  rowKey,
  onRowClick,
  rowClassName,
  empty = 'No rows.',
}: DataTableProps<TRow>) {
  const table = useTable({
    key: id,
    features,
    columns,
    data,
    ...(rowKey ? { getRowId: (row: TRow, index: number) => rowKey(row, index) } : {}),
  });
  const rows = table.getRowModel().rows;

  return (
    <div className="flex flex-col gap-2.5">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-6 text-center text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.id}
                className={cn(
                  onRowClick && 'cursor-pointer hover:bg-surface-2',
                  rowClassName?.(row.original),
                )}
                {...(onRowClick ? { onClick: () => onRowClick(row.original) } : {})}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className="mono">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {pagination && <Pager {...pagination} rowsOnPage={rows.length} />}
    </div>
  );
}

/**
 * Prev/Next with the page number. No "of N": the endpoints behind these tables
 * answer `hasMore` with one extra row instead of a COUNT over the same table the
 * pagination exists to stop scanning.
 */
function Pager({
  page,
  onPageChange,
  hasMore,
  isFetching = false,
  rowsOnPage,
}: DataTablePagination & { rowsOnPage: number }) {
  // Page 1 with nothing on it is the empty state, not a pager.
  if (page === 1 && !hasMore && rowsOnPage === 0) return null;
  return (
    <div className="flex items-center justify-end gap-2.5">
      <Button
        variant="outline"
        disabled={page <= 1 || isFetching}
        onClick={() => onPageChange(page - 1)}
      >
        ← Prev
      </Button>
      <span className="tnum text-muted-foreground">Page {page}</span>
      <Button
        variant="outline"
        disabled={!hasMore || isFetching}
        onClick={() => onPageChange(page + 1)}
      >
        Next →
      </Button>
    </div>
  );
}
