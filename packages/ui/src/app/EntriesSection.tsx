import { useMemo, useState } from 'react';
import { formatDuration, formatRelative, formatTime } from '../client/format.js';
import { ENTRY_TYPES, type EntriesQuery, type EntrySummary } from '../client/types.js';
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
}: {
  onOpenEntry: (id: string) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const [type, setType] = useState<string>('');
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
    <div className="stack">
      <Panel>
        <div className="controls" style={{ justifyContent: 'space-between' }}>
          <div className="controls">
            <select
              className="select"
              aria-label="filter by type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All types</option>
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="search"
              placeholder="Search summary + content…"
              aria-label="search entries"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitSearch()}
              onBlur={commitSearch}
            />
            <button type="button" className="btn" onClick={() => state.reload()}>
              Refresh
            </button>
          </div>
          <button
            type="button"
            className={`btn${live ? ' active' : ''}`}
            aria-pressed={live}
            onClick={() => setLive((v) => !v)}
          >
            {live ? <span className="live-dot" /> : null} Live tail
          </button>
        </div>

        {(type || search) && (
          <div className="controls" style={{ marginTop: 12 }}>
            {type && (
              <span className="chip">
                type: {type}
                <button type="button" aria-label="clear type" onClick={() => setType('')}>
                  ×
                </button>
              </span>
            )}
            {search && (
              <span className="chip">
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
              </span>
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
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Summary</th>
                    <th className="num">Duration</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e, i) => (
                    <tr
                      key={e.id}
                      className={`row-link${live && i < tail.entries.length ? ' row-new' : ''}`}
                      {...clickable(() => onOpenEntry(e.id))}
                    >
                      <td className="muted" title={e.createdAt}>
                        {formatRelative(e.createdAt) || formatTime(e.createdAt)}
                      </td>
                      <td>
                        <TypeBadge type={e.type} />
                      </td>
                      <td className="mono">{e.summary}</td>
                      <td className="num tnum">{formatDuration(e.durationMs)}</td>
                      <td>
                        {e.traceId && (
                          <button
                            type="button"
                            className="tag link"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenTrace(e.traceId as string);
                            }}
                          >
                            trace:{e.traceId.slice(0, 8)}
                          </button>
                        )}
                        {e.tags.slice(0, 4).map((t) => (
                          <span key={t} className="tag">
                            {t}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
