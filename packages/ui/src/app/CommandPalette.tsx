import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ENTRY_TYPES } from '../client/types.js';
import type { DashboardSpec } from '../client/types.js';
import { SearchIcon } from './icons.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import { Dialog } from './primitives/dialog.js';
import { Tooltip } from './primitives/tooltip.js';
import { typeColor, typeLabel } from './ui.js';

export type PaletteTarget =
  | {
      kind: 'section';
      key:
        | 'pulse'
        | 'entries'
        | 'traces'
        | 'exceptions'
        | 'exports'
        | 'profiles'
        | 'queues'
        | 'schedules';
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

/**
 * A global `Cmd/Ctrl+K` jump menu: a text filter over every page + entry type + extension
 * dashboard, arrow-key/Enter navigable. Self-contained — owns its own open state, closes on
 * Escape, on activation, or on an outside click of the backdrop.
 *
 * On a Base UI `Dialog` rather than a hand-rolled overlay `<div>`, matching
 * `@dudousxd/nestjs-telescope-ui`'s `command-palette.tsx`.
 */
export function CommandPalette({
  dashboards,
  onNavigate,
}: {
  dashboards: DashboardSpec[];
  onNavigate: (target: PaletteTarget) => void;
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
  const results = useMemo(() => filterActions(actions, query), [actions, query]);

  useEffect(() => {
    setHighlight((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results.length]);

  const activate = (action: PaletteAction | undefined) => {
    if (!action) return;
    onNavigate(action.target);
    setOpen(false);
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
          size="icon"
          aria-label="open command palette"
          onClick={() => setOpen(true)}
        >
          <SearchIcon />
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
          placeholder="Jump to…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {/* biome-ignore lint/a11y/useSemanticElements: composite ARIA listbox popup, see nestjs-telescope-ui's command-palette.tsx for the same pattern. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input; options are tracked via aria-activedescendant. */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA listbox, see note above. */}
        <ul id={listId} role="listbox" className="max-h-[46vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground">No matches.</li>
          )}
          {results.map((action, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input, see note above.
            <li
              key={action.id}
              id={`${listId}-${i}`}
              // biome-ignore lint/a11y/useSemanticElements: composite ARIA option, see note above.
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA option, see note above.
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                activate(action);
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-4 py-2 text-sm',
                i === highlight ? 'bg-panel-2 text-brand' : 'text-foreground',
              )}
            >
              {action.dot && (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: action.dot }}
                />
              )}
              <span className="flex-1">{action.label}</span>
              <span className="text-xs text-muted-foreground">{action.hint}</span>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
