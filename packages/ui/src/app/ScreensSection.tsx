import { useMemo, useState } from 'react';
import { formatCount, formatDuration, formatRelative } from '../client/format.js';
import type { ScreenStats } from '../client/types.js';
import { Button } from './primitives/button.js';
import { DataTable } from './primitives/data_table.js';
import { AsyncBlock, Panel, SectionTitle } from './ui.js';
import { useScreens } from './use-telescope.js';
import { WindowSelect } from './WindowSelect.js';

/** Rows per page, once the window's routes are loaded. */
const PAGE_SIZE = 20;

/** The three answers this screen can give, in the order someone asks for them. */
const KINDS = [
  { key: 'page', label: 'Screens', hint: 'pages people navigated to' },
  { key: 'api', label: 'API', hint: 'data fetched by code' },
  { key: 'asset', label: 'Assets', hint: 'static files' },
] as const;

/**
 * Per-route traffic, split by how the route was reached.
 *
 * The Entries list could not answer "which screens are most used": a page visit and
 * the dozen XHRs that page fires are all `request` entries with a url, so one list
 * had to serve two questions and served neither. The split lives in the entry now
 * (`content.kind`), and this screen is what it is for.
 */
export function ScreensSection({ onOpenType }: { onOpenType: (type: string) => void }) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [kind, setKind] = useState<string>('page');
  const state = useScreens(windowMs, kind);

  const columns = useMemo(
    () => [
      { id: 'url', header: 'Route', accessorFn: (s: ScreenStats) => s.url },
      {
        id: 'count',
        header: () => <span className="block text-right">Hits</span>,
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className="tnum block text-right">{formatCount(row.original.count)}</span>
        ),
      },
      {
        id: 'users',
        header: () => <span className="block text-right">Users</span>,
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className="tnum block text-right">
            {/* Zero distinct users means nobody was identified, not nobody visited. */}
            {row.original.users === 0 ? '—' : formatCount(row.original.users)}
          </span>
        ),
      },
      {
        id: 'avgMs',
        header: () => <span className="block text-right">Avg</span>,
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className="tnum block text-right">{formatDuration(row.original.avgMs)}</span>
        ),
      },
      {
        id: 'maxMs',
        header: () => <span className="block text-right">Max</span>,
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className="tnum block text-right text-muted-foreground">
            {formatDuration(row.original.maxMs)}
          </span>
        ),
      },
      {
        id: 'errors',
        header: () => <span className="block text-right">Errors</span>,
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className={`tnum block text-right ${row.original.errors > 0 ? 'text-bad' : ''}`}>
            {row.original.errors === 0 ? '—' : formatCount(row.original.errors)}
          </span>
        ),
      },
      {
        id: 'lastAt',
        header: 'Last hit',
        cell: ({ row }: { row: { original: ScreenStats } }) => (
          <span className="text-muted-foreground" title={row.original.lastAt}>
            {formatRelative(row.original.lastAt)}
          </span>
        ),
      },
    ],
    [],
  );

  const active = KINDS.find((k) => k.key === kind) ?? KINDS[0];

  return (
    <Panel>
      <SectionTitle
        title="Screens"
        hint={<WindowSelect value={windowMs} onChange={setWindowMs} />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <Button
            key={k.key}
            variant={kind === k.key ? 'brand' : 'outline'}
            aria-pressed={kind === k.key}
            onClick={() => setKind(k.key)}
          >
            {k.label}
          </Button>
        ))}
        <span className="text-muted-foreground text-xs">{active.hint}</span>
      </div>
      <AsyncBlock
        state={state}
        isEmpty={(rows) => rows.length === 0}
        empty="No requests of this kind in this window."
        skeletonRows={6}
      >
        {(rows) => (
          <DataTable
            id={`screens-${kind}`}
            data={rows}
            columns={columns}
            rowKey={(s) => `${s.kind} ${s.url}`}
            onRowClick={() => onOpenType('request')}
            rowClassName={() => 'hover:bg-brand/5'}
            // Client-side: the window's routes are an aggregate the browser already
            // holds in full, so paging here costs no round trip and hides nothing.
            clientPageSize={PAGE_SIZE}
          />
        )}
      </AsyncBlock>
    </Panel>
  );
}
