import { useMemo, useState } from 'react';
import type { TraceSummary } from '../client/types.js';
import { formatDuration, formatRelative } from '../client/format.js';
import { DataTable } from './primitives/data_table.js';
import { AsyncBlock, Panel, SectionTitle, typeColor } from './ui.js';
import { useTracesPage } from './use-telescope.js';

/** Traces per page. Small on purpose: this list is scanned, not read in bulk, and a
 *  page is one round trip to a grouped query. */
const PAGE_SIZE = 25;

/** The recent-traces list: root label, the type mix (colored dots), entry count, total time. */
export function TracesSection({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const [page, setPage] = useState(1);
  const state = useTracesPage(PAGE_SIZE, page);

  const columns = useMemo(
    () => [
      {
        id: 'trace',
        header: 'Trace',
        accessorFn: (t: TraceSummary) => t.rootLabel ?? t.traceId.slice(0, 16),
      },
      {
        id: 'user',
        header: 'User',
        accessorFn: (t: TraceSummary) => t.userLabel ?? '—',
        cell: ({ getValue }: { getValue: () => unknown }) => (
          <span className="text-muted-foreground">{String(getValue())}</span>
        ),
      },
      {
        id: 'types',
        header: 'Types',
        cell: ({ row }: { row: { original: TraceSummary } }) => (
          <span className="flex items-center gap-1.5">
            {row.original.types.map((type) => (
              <span
                key={type}
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                title={type}
                style={{ background: typeColor(type) }}
              />
            ))}
          </span>
        ),
      },
      {
        id: 'entries',
        header: () => <span className="block text-right">Entries</span>,
        cell: ({ row }: { row: { original: TraceSummary } }) => (
          <span className="tnum block text-right">{row.original.entryCount}</span>
        ),
      },
      {
        id: 'total',
        header: () => <span className="block text-right">Total</span>,
        cell: ({ row }: { row: { original: TraceSummary } }) => (
          <span className="tnum block text-right">
            {formatDuration(row.original.totalDurationMs)}
          </span>
        ),
      },
      {
        id: 'lastAt',
        header: 'Last active',
        cell: ({ row }: { row: { original: TraceSummary } }) => (
          <span className="text-muted-foreground" title={row.original.lastAt}>
            {formatRelative(row.original.lastAt)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Panel>
      <SectionTitle title="Traces" hint="recent, newest-active first" />
      <AsyncBlock
        state={state}
        // Page 2+ coming back empty is a real (if odd) state, not "nothing recorded":
        // only page 1 empty means the console has no traces at all.
        isEmpty={(p) => p.rows.length === 0 && p.page === 1}
        empty="No traces recorded yet."
        skeletonRows={6}
      >
        {(result) => (
          <DataTable
            id="traces"
            data={result.rows}
            columns={columns}
            rowKey={(t) => t.traceId}
            onRowClick={(t) => onOpenTrace(t.traceId)}
            rowClassName={() => 'hover:bg-brand/5'}
            pagination={{
              page,
              onPageChange: setPage,
              hasMore: result.hasMore,
              isFetching: state.loading,
            }}
          />
        )}
      </AsyncBlock>
    </Panel>
  );
}
