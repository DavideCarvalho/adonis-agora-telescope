import { useMemo, useState } from 'react';
import { formatDuration, formatRelative, formatTime } from '../client/format.js';
import { ENTRY_TYPES, type EntriesQuery, type EntrySummary } from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import { DataTable } from './primitives/data_table.js';
import { InputField } from './primitives/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './primitives/select.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge } from './ui.js';
import { useEntriesPage, useLiveTail } from './use-telescope.js';

/** Rows per page. The list is scanned, not read in bulk. */
const PAGE_SIZE = 50;

/**
 * The entries list: filter by type + free-text search, with an SSE live-tail toggle that prepends
 * newly-recorded entries as they arrive. Rows deep-link to the entry detail; a `trace:` pill jumps to
 * the trace waterfall.
 */
export function EntriesSection({
  onOpenEntry,
  onOpenTrace,
  presetType,
}: {
  onOpenEntry: (id: string) => void;
  onOpenTrace: (traceId: string) => void;
  /** Initial type filter (e.g. from the command palette's "Entries: &lt;type&gt;" actions). Only
   *  read once on mount — pass a remounting `key` from the caller to re-apply a new preset. */
  presetType?: string;
}) {
  const [type, setType] = useState<string>(presetType ?? '');
  const [search, setSearch] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [live, setLive] = useState(false);

  const [page, setPage] = useState(1);

  const query: EntriesQuery = useMemo(
    () => ({ ...(type ? { type } : {}), ...(search ? { search } : {}), limit: PAGE_SIZE, page }),
    [type, search, page],
  );
  const state = useEntriesPage(query);
  // Live tail only runs on page 1. Prepending arriving rows onto page 3 would shift
  // every row down and silently push one off the bottom -- the list would be lying
  // about what page 3 contains.
  const tail = useLiveTail(live && page === 1);

  /** Any filter change restarts at page 1: page 4 of the previous filter has nothing
   *  to do with page 4 of the new one, and landing on an empty page reads as "no
   *  results" when there are plenty. */
  const changeType = (next: string) => {
    setType(next);
    setPage(1);
  };
  const changeSearch = (next: string) => {
    setSearch(next);
    setPage(1);
  };

  // Merge live-tail entries (newest-first) ahead of the fetched page, de-duped by id, and respect the
  // active type/search filter so the tail never shows rows the filter would exclude.
  const rows: EntrySummary[] = useMemo(() => {
    const base = state.data?.rows ?? [];
    if (!live || page !== 1 || tail.entries.length === 0) return base;
    const matches = (e: EntrySummary) =>
      (!type || e.type === type) &&
      (!search || e.summary.toLowerCase().includes(search.toLowerCase()));
    const seen = new Set<string>();
    const merged: EntrySummary[] = [];
    for (const e of [...tail.entries.filter(matches), ...base]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged;
  }, [state.data, tail.entries, live, page, type, search]);

  const columns = useMemo(
    () => [
      {
        id: 'time',
        header: 'Time',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <span className="text-muted-foreground" title={row.original.createdAt}>
            {formatRelative(row.original.createdAt) || formatTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <TypeBadge type={row.original.type} />
        ),
      },
      { id: 'summary', header: 'Summary', accessorFn: (e: EntrySummary) => e.summary },
      {
        id: 'user',
        header: 'User',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <span className="text-muted-foreground">{row.original.userLabel ?? '—'}</span>
        ),
      },
      {
        id: 'duration',
        header: () => <span className="block text-right">Duration</span>,
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <span className="tnum block text-right">{formatDuration(row.original.durationMs)}</span>
        ),
      },
      {
        id: 'tags',
        header: 'Tags',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <div className="flex flex-wrap items-center gap-1">
            {row.original.traceId && (
              <button
                type="button"
                className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-brand"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenTrace(row.original.traceId as string);
                }}
              >
                trace:{row.original.traceId.slice(0, 8)}
              </button>
            )}
            {row.original.tags.slice(0, 4).map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        ),
      },
    ],
    [onOpenTrace],
  );

  const commitSearch = () => changeSearch(draft.trim());

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Select
              value={type}
              onValueChange={(next) => changeType(typeof next === 'string' ? next : '')}
            >
              <SelectTrigger aria-label="filter by type" className="min-w-36">
                <SelectValue>{(v: string | null) => (v ? v : 'All types')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All types</SelectItem>
                {ENTRY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InputField
              type="search"
              placeholder="Search summary + content…"
              aria-label="search entries"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitSearch()}
              onBlur={commitSearch}
              containerClassName="min-w-[220px]"
              onClear={() => {
                setDraft('');
                commitSearch();
              }}
            />
            <Button variant="outline" onClick={() => state.reload()}>
              Refresh
            </Button>
          </div>
          <Button
            variant={live ? 'brand' : 'outline'}
            aria-pressed={live}
            onClick={() => setLive((v) => !v)}
          >
            {live ? <span className="live-dot" /> : null} Live tail
          </Button>
        </div>

        {(type || search) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {type && (
              <Badge variant="outline" className="gap-1.5 rounded-full px-2.5 py-1">
                type: {type}
                <button type="button" aria-label="clear type" onClick={() => changeType('')}>
                  ×
                </button>
              </Badge>
            )}
            {search && (
              <Badge variant="outline" className="gap-1.5 rounded-full px-2.5 py-1">
                search: “{search}”
                <button
                  type="button"
                  aria-label="clear search"
                  onClick={() => {
                    changeSearch('');
                    setDraft('');
                  }}
                >
                  ×
                </button>
              </Badge>
            )}
          </div>
        )}
      </Panel>

      <Panel>
        <SectionTitle
          title="Entries"
          hint={
            live
              ? liveHint(tail.status, rows.length)
              : `${rows.length} shown${state.loading ? ' · loading…' : ''}`
          }
        />
        <AsyncBlock
          state={state}
          isEmpty={() => rows.length === 0}
          empty="No entries match these filters."
          skeletonRows={6}
        >
          {() => (
            <DataTable
              id="entries"
              data={rows}
              columns={columns}
              rowKey={(e) => e.id}
              onRowClick={(e) => onOpenEntry(e.id)}
              rowClassName={(e) =>
                cn(
                  'hover:bg-brand/5',
                  live && page === 1 && tail.entries.some((t) => t.id === e.id) && 'row-new',
                )
              }
              pagination={{
                page,
                onPageChange: setPage,
                hasMore: state.data?.hasMore ?? false,
                isFetching: state.loading,
              }}
            />
          )}
        </AsyncBlock>
      </Panel>
    </div>
  );
}

function liveHint(status: string, count: number): string {
  if (status === 'unsupported') return 'live tail unavailable (no EventSource)';
  if (status === 'error') return 'live · reconnecting…';
  if (status === 'connecting') return 'live · connecting…';
  return `live · ${count} shown`;
}
