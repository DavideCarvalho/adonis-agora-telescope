import { useMemo } from 'react';
import { formatDuration, formatRelative } from '../client/format.js';
import type { TraceSummary } from '../client/types.js';
import { appLabel } from './AppPicker.js';
import { DataTable } from './primitives/data_table.js';
import { AsyncBlock, PageHeader, Panel, SectionTitle, typeStyle } from './ui.js';
import { useApps, useCursorPager, useTracesPage } from './use-telescope.js';

/** The apps a trace crossed, the one that started it first: `shop → billing`. */
export function TraceApps({ apps, labelOf }: { apps: string[]; labelOf: (id: string) => string }) {
  if (apps.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="mono text-xs"
      title={apps.length > 1 ? `crosses ${apps.length} apps` : undefined}
    >
      {apps.map(labelOf).join(' → ')}
    </span>
  );
}

/** Traces per page. Small on purpose: this list is scanned, not read in bulk, and a
 *  page is one round trip to a grouped query. */
const PAGE_SIZE = 25;

/** The recent-traces list: root label, the type mix (colored dots), entry count, total time. */
export function TracesSection({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const pager = useCursorPager();
  const page = pager.page;
  const state = useTracesPage(PAGE_SIZE, pager.after);
  const appScope = useApps().data;
  // The Apps column on a server that collects several apps: decided by the app scope, not by the
  // page, so it does not come and go between pages. A row naming apps shows it too (an older
  // server without the apps endpoint).
  const showApps =
    appScope?.enabled === true || (state.data?.data ?? []).some((t) => (t.apps?.length ?? 0) > 0);

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
      ...(showApps
        ? [
            {
              id: 'apps',
              header: 'Apps',
              cell: ({ row }: { row: { original: TraceSummary } }) => (
                <TraceApps
                  apps={row.original.apps ?? []}
                  labelOf={(id) => appLabel(appScope, id)}
                />
              ),
            },
          ]
        : []),
      {
        id: 'types',
        header: 'Types',
        cell: ({ row }: { row: { original: TraceSummary } }) => (
          <span className="flex items-center gap-1.5">
            {row.original.types.map((type) => (
              <span
                key={type}
                className="type-ink size-2 shrink-0 rounded-full bg-current"
                title={type}
                style={typeStyle(type)}
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
    [showApps, appScope],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Traces"
        description="Every request, job and command as one trace. A row opens its waterfall."
      />
      <Panel>
        <SectionTitle title="Recent traces" hint="newest-active first" />
        <AsyncBlock
          state={state}
          // Page 2+ coming back empty is a real (if odd) state, not "nothing recorded":
          // only page 1 empty means the console has no traces at all.
          isEmpty={(p) => p.data.length === 0 && page === 1}
          empty="No traces recorded yet."
          skeletonRows={6}
        >
          {(result) => (
            <DataTable
              id="traces"
              data={result.data}
              columns={columns}
              rowKey={(t) => t.traceId}
              onRowClick={(t) => onOpenTrace(t.traceId)}
              pagination={{
                page,
                onPageChange: (next) => pager.onPageChange(next, result.meta.nextCursor),
                hasMore: result.meta.hasNext,
                isFetching: state.loading,
              }}
            />
          )}
        </AsyncBlock>
      </Panel>
    </div>
  );
}
