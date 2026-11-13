import { useMemo, useState } from 'react';
import { Toolbar } from '../agora-kit/blocks/page-header';
import { RefreshIcon, SearchIcon, XIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { formatDuration, formatRelative, formatTime } from '../client/format.js';
import { selectedTenant } from '../client/telescope-client.js';
import { ENTRY_TYPES, type EntriesQuery, type EntrySummary } from '../client/types.js';
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
import { tenantLabel } from './TenantPicker.js';
import { AsyncBlock, PageHeader, Panel, SectionTitle, TypeBadge, typeLabel } from './ui.js';
import { useCursorPager, useEntriesPage, useLiveTail, useTenants } from './use-telescope.js';

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

  const pager = useCursorPager();
  const page = pager.page;
  const after = pager.after;

  const query: EntriesQuery = useMemo(
    () => ({
      ...(type ? { type } : {}),
      ...(search ? { search } : {}),
      first: PAGE_SIZE,
      ...(after !== undefined ? { after } : {}),
    }),
    [type, search, after],
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
    pager.reset();
  };
  const changeSearch = (next: string) => {
    setSearch(next);
    pager.reset();
  };

  // Merge live-tail entries (newest-first) ahead of the fetched page, de-duped by id, and respect the
  // active type/search filter so the tail never shows rows the filter would exclude.
  const rows: EntrySummary[] = useMemo(() => {
    const base = state.data?.data ?? [];
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

  // Ids of the rows that arrived through the live tail, for the "new row" highlight —
  // a Set so styling each row is a lookup rather than a scan of the whole tail.
  const tailIds = useMemo(() => new Set(tail.entries.map((t) => t.id)), [tail.entries]);

  // With more than one organization in view, say which one each entry belongs to.
  const tenants = useTenants();
  const showOrganization =
    tenants.data?.enabled === true &&
    (tenants.data.all || tenants.data.tenants.length > 1) &&
    selectedTenant() === undefined;

  const columns = useMemo(
    () => [
      {
        id: 'time',
        header: 'Time',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <span className="whitespace-nowrap text-faint" title={row.original.createdAt}>
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
          <span className="text-dim">{row.original.userLabel ?? '—'}</span>
        ),
      },
      {
        id: 'duration',
        header: () => <span className="block text-right">Duration</span>,
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <span className="tnum block text-right">{formatDuration(row.original.durationMs)}</span>
        ),
      },
      ...(showOrganization
        ? [
            {
              id: 'organization',
              header: 'Organization',
              cell: ({ row }: { row: { original: EntrySummary } }) => {
                const prefix = `${tenants.data?.tag ?? 'tenant'}:`;
                const tag = row.original.tags.find(
                  (t) => t.startsWith(prefix) && t !== `${prefix}*`,
                );
                return (
                  <span className="text-muted-foreground">
                    {tag ? tenantLabel(tenants.data, tag.slice(prefix.length)) : '—'}
                  </span>
                );
              },
            },
          ]
        : []),
      {
        id: 'tags',
        header: 'Tags',
        cell: ({ row }: { row: { original: EntrySummary } }) => (
          <div className="flex flex-wrap items-center gap-1">
            {row.original.traceId && (
              <button
                type="button"
                className="mono inline-flex h-[18px] items-center rounded-full border border-brand-border bg-brand-soft px-2 text-[10px] text-brand transition-colors hover:bg-brand/20"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenTrace(row.original.traceId as string);
                }}
              >
                trace:{row.original.traceId.slice(0, 8)}
              </button>
            )}
            {row.original.tags.slice(0, 4).map((t) => (
              <Badge key={t} variant="neutral">
                {t}
              </Badge>
            ))}
          </div>
        ),
      },
    ],
    [onOpenTrace, showOrganization, tenants.data],
  );

  const commitSearch = () => changeSearch(draft.trim());

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={presetType ? `Entries · ${typeLabel(presetType)}` : 'Entries'}
        description="Everything Telescope recorded, newest first. A row opens the entry; a trace pill its waterfall."
        actions={
          <>
            <Button variant="outline" onClick={() => state.reload()}>
              <RefreshIcon />
              Refresh
            </Button>
            <Button
              variant={live ? 'brand' : 'outline'}
              aria-pressed={live}
              onClick={() => setLive((v) => !v)}
            >
              {live ? <span className="live-dot" /> : null} Live tail
            </Button>
          </>
        }
      />
      <Toolbar label="entry filters">
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
          glyph={<SearchIcon />}
          placeholder="Search summary + content…"
          aria-label="search entries"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitSearch()}
          onBlur={commitSearch}
          containerClassName="w-full sm:w-72"
          onClear={() => {
            setDraft('');
            commitSearch();
          }}
        />
        {type && (
          <Badge variant="brand" className="h-[22px] gap-1.5 px-2.5">
            type: {type}
            <button
              type="button"
              aria-label="clear type"
              className="opacity-70 hover:opacity-100"
              onClick={() => changeType('')}
            >
              <XIcon size={11} />
            </button>
          </Badge>
        )}
        {search && (
          <Badge variant="brand" className="h-[22px] gap-1.5 px-2.5">
            search: “{search}”
            <button
              type="button"
              aria-label="clear search"
              className="opacity-70 hover:opacity-100"
              onClick={() => {
                changeSearch('');
                setDraft('');
              }}
            >
              <XIcon size={11} />
            </button>
          </Badge>
        )}
      </Toolbar>

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
              rowClassName={(e) => cn(live && page === 1 && tailIds.has(e.id) && 'row-new')}
              pagination={{
                page,
                onPageChange: (next) => pager.onPageChange(next, state.data?.meta.nextCursor),
                hasMore: state.data?.meta.hasNext ?? false,
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
