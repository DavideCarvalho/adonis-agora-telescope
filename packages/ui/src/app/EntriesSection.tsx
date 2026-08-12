import { useMemo, useState } from 'react';
import { formatDuration, formatRelative, formatTime } from '../client/format.js';
import { ENTRY_TYPES, type EntriesQuery, type EntrySummary } from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import { InputField } from './primitives/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './primitives/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge, clickable } from './ui.js';
import { useEntries, useLiveTail } from './use-telescope.js';

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

  const query: EntriesQuery = useMemo(
    () => ({ ...(type ? { type } : {}), ...(search ? { search } : {}), limit: 100 }),
    [type, search],
  );
  const state = useEntries(query);
  const tail = useLiveTail(live);

  // Merge live-tail entries (newest-first) ahead of the fetched page, de-duped by id, and respect the
  // active type/search filter so the tail never shows rows the filter would exclude.
  const rows: EntrySummary[] = useMemo(() => {
    const base = state.data ?? [];
    if (!live || tail.entries.length === 0) return base;
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
  }, [state.data, tail.entries, live, type, search]);

  const commitSearch = () => setSearch(draft.trim());

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Select
              value={type}
              onValueChange={(next) => setType(typeof next === 'string' ? next : '')}
            >
              <SelectTrigger aria-label="filter by type" className="min-w-[9rem]">
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
                <button type="button" aria-label="clear type" onClick={() => setType('')}>
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
                    setSearch('');
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Tags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e, i) => (
                  <TableRow
                    key={e.id}
                    className={cn(
                      'cursor-pointer hover:bg-brand/5',
                      live && i < tail.entries.length && 'row-new',
                    )}
                    {...clickable(() => onOpenEntry(e.id))}
                  >
                    <TableCell className="text-muted-foreground" title={e.createdAt}>
                      {formatRelative(e.createdAt) || formatTime(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={e.type} />
                    </TableCell>
                    <TableCell className="mono">{e.summary}</TableCell>
                    <TableCell className="tnum text-right">
                      {formatDuration(e.durationMs)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {e.traceId && (
                          <button
                            type="button"
                            className="rounded border border-line px-1.5 py-0.5 text-[11px] text-brand"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenTrace(e.traceId as string);
                            }}
                          >
                            trace:{e.traceId.slice(0, 8)}
                          </button>
                        )}
                        {e.tags.slice(0, 4).map((t) => (
                          <Badge key={t} variant="outline">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
