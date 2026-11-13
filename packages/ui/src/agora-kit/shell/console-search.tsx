import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type SearchGroup, searchConsoles } from '../console-data';
import { ConsoleTile, consoleAccent, SearchIcon } from '../icons';
import { cn } from '../lib/utils';
import type { SearchConfig } from '../shell-config';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Kbd } from '../ui/kbd';

/**
 * A console-local ⌘K entry (a page, a filter, a view), matched in the browser on its label and
 * keywords and listed above the cross-console hits. `onSelect` runs in-app (no navigation).
 */
export interface SearchCommand {
  id: string;
  label: string;
  /** Group heading ("Pages", "Entry types"). */
  group: string;
  hint?: string;
  /** A 16px icon or a colour dot. */
  icon?: ReactNode;
  keywords?: string[];
  onSelect: () => void;
}

/** Case-insensitive substring match on label + keywords; an empty query keeps everything. */
export function filterCommands(commands: readonly SearchCommand[], q: string): SearchCommand[] {
  const query = q.trim().toLowerCase();
  if (query === '') return [...commands];
  return commands.filter((c) =>
    [c.label, ...(c.keywords ?? [])].some((text) => text.toLowerCase().includes(query)),
  );
}

/** Ctrl/Cmd-K toggles `setOpen` while `enabled`. */
export function useSearchShortcut(
  enabled: boolean,
  setOpen: (fn: (open: boolean) => boolean) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, setOpen]);
}

/** The topbar's search button ("Search ⌘K"). */
export function SearchTrigger({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts="Control+K Meta+K"
      aria-label="Search all consoles"
      className={cn(
        'flex h-[26px] items-center gap-2 rounded-[6px] px-2.5 text-[11px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        className,
      )}
    >
      <SearchIcon className="size-[13px]" />
      <span className="hidden sm:inline">Search</span>
      <Kbd className="mono hidden h-4 text-[9px] sm:inline-flex">⌘K</Kbd>
    </button>
  );
}

/**
 * ⌘K: one query across every console the viewer may open, grouped by console (shadcn `Command`
 * on cmdk, server-filtered). Enter or click follows the hit (a same-origin link). A console may
 * add its own `commands` (agora: local jumps, filtered in the browser, listed first); without a
 * `config` only those are searched.
 */
export function ConsoleSearch({
  config,
  commands,
  open,
  onOpenChange,
  placeholder = 'Search runs, payments, users…',
}: {
  config?: SearchConfig | undefined;
  commands?: readonly SearchCommand[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const local = useMemo(() => filterCommands(commands ?? [], q), [commands, q]);
  const localGroups = useMemo(() => {
    const byGroup = new Map<string, SearchCommand[]>();
    for (const c of local) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);
    return [...byGroup.entries()];
  }, [local]);

  useEffect(() => {
    const query = q.trim();
    if (query === '' || !config) {
      setGroups([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void searchConsoles(config, query, controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        setGroups(found);
        setLoading(false);
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, config]);

  const label = config ? 'Search all consoles' : 'Search';
  const go = (href: string) => {
    onOpenChange(false);
    window.location.assign(href);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={label}
      description={config ? 'Search every console you can open' : 'Jump to a page'}
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} label={label}>
        <CommandInput value={q} onValueChange={setQ} placeholder={placeholder} aria-label={label} />
        <CommandList className="max-h-[60vh]">
          {q.trim() === '' && local.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-dim">Type to search.</p>
          ) : loading && groups.length === 0 && local.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-dim">Searching…</p>
          ) : (
            <CommandEmpty className="text-dim">Nothing found.</CommandEmpty>
          )}
          {localGroups.map(([group, items]) => (
            <CommandGroup
              key={`local:${group}`}
              heading={<span className="uppercase tracking-[0.14em]">{group}</span>}
            >
              {items.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`local:${c.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    c.onSelect();
                  }}
                >
                  {c.icon}
                  <span className="truncate text-[13px] text-fg">{c.label}</span>
                  {c.hint && <span className="ml-auto text-[11px] text-dim">{c.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {groups.map((group) => (
            <CommandGroup
              key={group.id}
              heading={
                <span className="flex items-center gap-1.5 uppercase tracking-[0.14em]">
                  <ConsoleTile
                    icon={group.icon}
                    accent={consoleAccent(group.id, group.icon)}
                    size={18}
                  />
                  {group.title}
                </span>
              }
            >
              {group.hits.map((hit) => (
                <CommandItem
                  key={hit.href}
                  value={`${group.id}:${hit.href}`}
                  onSelect={() => go(hit.href)}
                >
                  <a
                    href={hit.href}
                    tabIndex={-1}
                    className="flex min-w-0 flex-col"
                    onClick={(e) => {
                      e.preventDefault();
                      go(hit.href);
                    }}
                  >
                    <span className="mono truncate text-[13px] text-fg">{hit.title}</span>
                    {hit.subtitle && (
                      <span className="truncate text-[11px] text-dim">{hit.subtitle}</span>
                    )}
                  </a>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
