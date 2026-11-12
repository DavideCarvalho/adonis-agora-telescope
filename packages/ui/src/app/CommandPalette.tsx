import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type ConsoleSearchGroup,
  type ConsoleSearchHit,
  getJson,
  parseSearchGroups,
} from '../client/console_switcher.js';
import type { DashboardSpec } from '../client/types.js';
import { ENTRY_TYPES } from '../client/types.js';
import { ConsoleIcon } from './console-switcher-icons.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import { Dialog } from './primitives/dialog.js';
import { Tooltip } from './primitives/tooltip.js';
import { typeColor, typeLabel } from './ui.js';

export type PaletteTarget =
  | {
      kind: 'section';
      key:
        | 'overview'
        | 'pulse'
        | 'entries'
        | 'traces'
        | 'ai'
        | 'exceptions'
        | 'exports'
        | 'profiles'
        | 'queues'
        | 'schedules'
        | 'extensions';
    }
  | { kind: 'entryType'; type: string }
  | { kind: 'dashboard'; id: string };

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  dot?: string;
  target: PaletteTarget;
}

const PAGE_ACTIONS: PaletteAction[] = [
  {
    id: 'overview',
    label: 'Overview',
    hint: 'triage grid',
    target: { kind: 'section', key: 'overview' },
  },
  {
    id: 'pulse',
    label: 'Pulse',
    hint: 'health overview',
    target: { kind: 'section', key: 'pulse' },
  },
  {
    id: 'entries',
    label: 'Entries',
    hint: 'browse + live tail',
    target: { kind: 'section', key: 'entries' },
  },
  {
    id: 'traces',
    label: 'Traces',
    hint: 'waterfall + N+1',
    target: { kind: 'section', key: 'traces' },
  },
  {
    id: 'ai',
    label: 'AI',
    hint: 'spend + agent runs',
    target: { kind: 'section', key: 'ai' },
  },
  {
    id: 'exceptions',
    label: 'Exceptions',
    hint: 'grouped by class',
    target: { kind: 'section', key: 'exceptions' },
  },
  {
    id: 'exports',
    label: 'Exports',
    hint: 'JSON / CSV',
    target: { kind: 'section', key: 'exports' },
  },
  {
    id: 'profiles',
    label: 'CPU Profiles',
    hint: 'flamegraphs',
    target: { kind: 'section', key: 'profiles' },
  },
  {
    id: 'queues',
    label: 'Queue Manager',
    hint: 'live jobs',
    target: { kind: 'section', key: 'queues' },
  },
  {
    id: 'schedules',
    label: 'Live Schedules',
    hint: 'next-run + history',
    target: { kind: 'section', key: 'schedules' },
  },
];

function buildActions(dashboards: DashboardSpec[]): PaletteAction[] {
  const entryTypeActions: PaletteAction[] = ENTRY_TYPES.map((type) => ({
    id: `type:${type}`,
    label: `Entries: ${typeLabel(type)}`,
    hint: 'jump filtered',
    dot: typeColor(type),
    target: { kind: 'entryType', type },
  }));
  const dashboardActions: PaletteAction[] = dashboards.map((d) => ({
    id: `dashboard:${d.id}`,
    label: `Extension: ${d.label}`,
    hint: 'dashboard panel',
    target: { kind: 'dashboard', id: d.id },
  }));
  return [...PAGE_ACTIONS, ...entryTypeActions, ...dashboardActions];
}

/** Case-insensitive substring match on the action's label. Exported for unit testing. */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (q === '') return actions;
  return actions.filter((a) => a.label.toLowerCase().includes(q));
}

/** `value`, settled for `ms` (the search request waits for typing to pause). */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The global console search for `query` (at least 2 characters), aborted when the query changes.
 * A failure just shows no hits: the local jumps still work.
 */
function useConsoleSearch(
  endpoint: string | undefined,
  query: string,
): { groups: ConsoleSearchGroup[]; isFetching: boolean } {
  const [state, setState] = useState<{ groups: ConsoleSearchGroup[]; isFetching: boolean }>({
    groups: [],
    isFetching: false,
  });
  useEffect(() => {
    if (endpoint === undefined || query.length < 2) {
      setState({ groups: [], isFetching: false });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ groups: current.groups, isFetching: true }));
    getJson(`${endpoint}?q=${encodeURIComponent(query)}`, controller.signal)
      .then((body) => setState({ groups: parseSearchGroups(body), isFetching: false }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ groups: [], isFetching: false });
      });
    return () => controller.abort();
  }, [endpoint, query]);
  return state;
}

/** A palette row: a local jump, or a hit from the global console search. */
type PaletteRow =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'hit'; group: ConsoleSearchGroup; hit: ConsoleSearchHit };

/**
 * A global `Cmd/Ctrl+K` jump menu: a text filter over every page + entry type + extension
 * dashboard, plus (when other Agora consoles are installed) a global search across Telescope's
 * entries and every console the viewer may open, arrow-key/Enter navigable. Self-contained — owns its own open state, closes on
 * Escape, on activation, or on an outside click of the backdrop.
 *
 * On a Base UI `Dialog` rather than a hand-rolled overlay `<div>`, matching
 * `@dudousxd/nestjs-telescope-ui`'s `command-palette.tsx`.
 */
export function CommandPalette({
  dashboards,
  onNavigate,
  searchEndpoint,
}: {
  dashboards: DashboardSpec[];
  onNavigate: (target: PaletteTarget) => void;
  /** `GET <api>/consoles/search`: when set, typing also searches every console the viewer may open. */
  searchEndpoint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
  }, [open]);

  const actions = useMemo(() => buildActions(dashboards), [dashboards]);
  const local = useMemo(() => filterActions(actions, query), [actions, query]);
  const debounced = useDebounced(query.trim(), 200);
  const search = useConsoleSearch(open ? searchEndpoint : undefined, debounced);
  const groups = useMemo(
    () => (debounced.length >= 2 ? search.groups : []),
    [debounced, search.groups],
  );
  const results = useMemo<PaletteRow[]>(
    () => [
      ...local.map((action) => ({ kind: 'action' as const, action })),
      ...groups.flatMap((group) => group.hits.map((hit) => ({ kind: 'hit' as const, group, hit }))),
    ],
    [local, groups],
  );

  useEffect(() => {
    setHighlight((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results.length]);

  const activate = (row: PaletteRow | undefined) => {
    if (!row) return;
    setOpen(false);
    if (row.kind === 'action') onNavigate(row.action.target);
    else window.location.assign(row.hit.href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(results[highlight]);
    }
  };

  const activeId = results[highlight] ? `${listId}-${highlight}` : undefined;

  return (
    <>
      <Tooltip label="Jump to… (⌘K)">
        <Button
          variant="outline"
          className="normal-case"
          aria-label="open command palette"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">⌘K</span>
        </Button>
      </Tooltip>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        aria-label="command palette"
        className="overflow-hidden"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(activeId ? { 'aria-activedescendant': activeId } : {})}
          placeholder={searchEndpoint ? 'Jump to… or search every console' : 'Jump to…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
        />
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA listbox, see note above. */}
        <ul id={listId} role="listbox" className="max-h-[46vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground">No matches.</li>
          )}
          {results.map((row, i) => {
            const firstOfGroup =
              row.kind === 'hit' &&
              (i === 0 ||
                results[i - 1]?.kind !== 'hit' ||
                (results[i - 1] as { group: ConsoleSearchGroup }).group.id !== row.group.id);
            return (
              // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input, see note above.
              <li
                key={row.kind === 'action' ? row.action.id : `${row.group.id}:${row.hit.href}`}
                id={`${listId}-${i}`}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA option, see note above.
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  activate(row);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-4 py-2 text-sm',
                  firstOfGroup && 'border-t border-line',
                  i === highlight ? 'bg-panel-2 text-brand' : 'text-foreground',
                )}
              >
                {row.kind === 'action' ? (
                  <>
                    {row.action.dot && (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: row.action.dot }}
                      />
                    )}
                    <span className="flex-1">{row.action.label}</span>
                    <span className="text-xs text-muted-foreground">{row.action.hint}</span>
                  </>
                ) : (
                  <>
                    <ConsoleIcon icon={row.group.icon} size={14} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{row.hit.title}</span>
                      {row.hit.subtitle && (
                        <span className="truncate text-xs text-muted-foreground">
                          {row.hit.subtitle}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {row.group.title}
                    </span>
                  </>
                )}
              </li>
            );
          })}
          {typeof searchEndpoint === 'string' &&
            debounced.length >= 2 &&
            search.isFetching &&
            groups.length === 0 && (
              <li className="px-4 py-2 text-xs text-muted-foreground">Searching consoles…</li>
            )}
        </ul>
      </Dialog>
    </>
  );
}
