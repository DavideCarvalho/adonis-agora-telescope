import { useMemo, useState } from 'react';
import { formatCount, formatRelative } from '../client/format.js';
import type { ExceptionGroupStats } from '../client/types.js';
import { DataTable } from './primitives/data_table.js';
import { AsyncBlock, Panel, SectionTitle, Sparkline } from './ui.js';
import { useMetricsStats } from './use-telescope.js';
import { WindowSelect } from './WindowSelect.js';

/**
 * How many exception groups this screen asks for. The endpoint's default is 8, which
 * is right for the Overview tile and wrong here: on a dedicated Exceptions screen a
 * cap of 8 does not hide the 9th most common exception, it makes it unreachable.
 */
const GROUPS = 200;

/** Groups per page, once they are all loaded. */
const PAGE_SIZE = 15;

/**
 * Exception groups: `exception` AND `client_exception` entries grouped by class + message over a
 * window, with an occurrence count, a last-seen time, and an over-time sparkline.
 *
 * A row deep-links into the entries list filtered by THAT GROUP's type. It used to hard-code
 * `exception`, which meant every click on a browser-reported error landed on a list that could not
 * contain it — "0 shown" on a row that had just said the error happened 26 times.
 */
export function ExceptionsSection({ onOpenType }: { onOpenType: (type: string) => void }) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const state = useMetricsStats('exception', windowMs, GROUPS);

  const columns = useMemo(
    () => [
      {
        id: 'class',
        header: 'Class',
        cell: ({ row }: { row: { original: ExceptionGroupStats } }) => (
          <span className="text-bad">{row.original.class}</span>
        ),
      },
      { id: 'message', header: 'Message', accessorFn: (g: ExceptionGroupStats) => g.message },
      {
        id: 'count',
        header: () => <span className="block text-right">Count</span>,
        cell: ({ row }: { row: { original: ExceptionGroupStats } }) => (
          <span className="tnum block text-right">{formatCount(row.original.count)}</span>
        ),
      },
      {
        id: 'lastAt',
        header: 'Last seen',
        cell: ({ row }: { row: { original: ExceptionGroupStats } }) => (
          <span className="text-muted-foreground" title={row.original.lastAt}>
            {formatRelative(row.original.lastAt)}
          </span>
        ),
      },
      {
        id: 'trend',
        header: 'Trend',
        cell: ({ row }: { row: { original: ExceptionGroupStats } }) => (
          <Sparkline values={row.original.overTime} width={140} height={26} color="#f87171" />
        ),
      },
    ],
    [],
  );

  return (
    <Panel>
      <SectionTitle
        title="Exception groups"
        hint={<WindowSelect value={windowMs} onChange={setWindowMs} />}
      />
      <AsyncBlock
        state={state}
        isEmpty={(stats) => (stats.exceptions?.length ?? 0) === 0}
        empty="No exceptions recorded in this window. 🎉"
        skeletonRows={5}
      >
        {(stats) => (
          <DataTable
            id="exception-groups"
            data={stats.exceptions ?? []}
            columns={columns}
            rowKey={(g) => g.key}
            // Pelo tipo DAQUELE grupo, não `exception` fixo: um erro de browser é
            // `client_exception`, e mandar o clique para a lista de `exception` dava
            // "0 shown" numa linha que acabara de dizer que o erro ocorreu 26 vezes.
            onRowClick={(g) => onOpenType(g.type)}
            rowClassName={() => 'hover:bg-brand/5'}
            // Client-side: these rows are an aggregate the browser already holds in
            // full, so paging here saves no round trip and hides nothing.
            clientPageSize={PAGE_SIZE}
          />
        )}
      </AsyncBlock>
    </Panel>
  );
}
