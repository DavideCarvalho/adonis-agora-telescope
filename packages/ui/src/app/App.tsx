import { useEffect, useState } from 'react';
import { ENTRY_TYPES } from '../client/types.js';
import type { ExtensionEntryType } from '../client/types.js';
import { CommandPalette, type PaletteTarget } from './CommandPalette.js';
import { EntriesSection } from './EntriesSection.js';
import { EntryDetail } from './EntryDetail.js';
import { ExceptionsSection } from './ExceptionsSection.js';
import { ExportsSection } from './ExportsSection.js';
import { ExtensionsSection } from './ExtensionsSection.js';
import { OverviewSection } from './OverviewSection.js';
import { ProfilesSection } from './ProfilesSection.js';
import { PulseSection } from './PulseSection.js';
import { QueueManagerSection } from './QueueManagerSection.js';
import { RetentionIndicator } from './RetentionIndicator.js';
import { SchedulesLiveSection } from './SchedulesLiveSection.js';
import { TraceDetail } from './TraceDetail.js';
import { TracesSection } from './TracesSection.js';
import { MoonIcon, SunIcon } from './icons.js';
import { Button } from './primitives/button.js';
import { Tooltip, TooltipProvider } from './primitives/tooltip.js';
import { typeColor, typeLabel } from './ui.js';
import { useMeta } from './use-telescope.js';

type SectionKey =
  | 'overview'
  | 'pulse'
  | 'entries'
  | 'traces'
  | 'exceptions'
  | 'exports'
  | 'extensions'
  | 'profiles'
  | 'queues'
  | 'schedules';

/**
 * The sidebar's top-level section list — order matches `@dudousxd/nestjs-telescope-ui`'s
 * `DashboardLayout` NAV wherever this console shares the page (Overview, Entries, Traces, Pulse,
 * Queues, Schedules, Exports, Profiles), plus this console's own additions (Exceptions — a
 * dedicated grouped-exception view nestjs folds into Entries/Pulse instead; Extensions — the
 * single contributed-dashboard picker, vs. nestjs's one-nav-item-per-dashboard).
 */
const NAV: { key: SectionKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'entries', label: 'Entries' },
  { key: 'traces', label: 'Traces' },
  { key: 'pulse', label: 'Pulse' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'queues', label: 'Queues' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'exports', label: 'Exports' },
  { key: 'profiles', label: 'Profiles' },
  { key: 'extensions', label: 'Extensions' },
];

const THEME_STORAGE_KEY = 'telescope-theme';

function readStoredTheme(): 'light' | 'dark' | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: 'light' | 'dark' | null): void {
  try {
    if (theme) window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Private-mode / disabled storage: theme just won't persist across reloads.
  }
}

/** A watcher/entry-type nav row: built-ins from `ENTRY_TYPES` plus anything an extension
 *  contributed via `/api/meta` (e.g. `adonis-durable`'s "Workflows" type), de-duped by id. */
function watcherTypes(
  contributed: ExtensionEntryType[] | undefined,
): { id: string; label: string; dot: string }[] {
  const built = ENTRY_TYPES.map((id) => ({ id, label: typeLabel(id), dot: typeColor(id) }));
  const builtIds = new Set<string>(ENTRY_TYPES);
  const extra = (contributed ?? []).filter((c) => !builtIds.has(c.id));
  return [...built, ...extra];
}

function navItemClass(active: boolean): string {
  return `block rounded px-3 py-1.5 text-left text-xs uppercase tracking-wide ${
    active ? 'bg-panel-2 text-brand' : 'text-muted-foreground hover:bg-panel hover:text-foreground'
  }`;
}

function watcherItemClass(active: boolean): string {
  return `flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs ${
    active
      ? 'bg-panel-2 text-foreground'
      : 'text-muted-foreground hover:bg-panel hover:text-foreground'
  }`;
}

/**
 * The dashboard shell: a fixed left sidebar (brand + section nav + watchers sub-nav), a compact
 * header (retention, command palette, theme toggle), and the active view. A selected entry or
 * trace opens an overlay detail (entry wins over trace), so any list row / trace pill can
 * deep-dive without leaving the section it was opened from.
 *
 * Matches `@dudousxd/nestjs-telescope-ui`'s `DashboardLayout` structurally (sidebar nav, not top
 * tabs; monospace shell; flat black background; dense panels) — this dashboard has no router
 * (state-based section switching instead of `HashRouter`), so navigation is `go()`/`setSection`
 * rather than `<NavLink>`.
 */
export function App() {
  const [section, setSection] = useState<SectionKey>('overview');
  const [entryId, setEntryId] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => readStoredTheme());
  const [entryPreset, setEntryPreset] = useState<{ type: string; nonce: number } | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const meta = useMeta();

  useEffect(() => {
    const root = document.documentElement;
    const resolved = theme ?? 'dark';
    root.classList.toggle('light', resolved === 'light');
    storeTheme(theme);
  }, [theme]);

  const openEntry = (id: string) => setEntryId(id);
  const openTrace = (id: string) => {
    setEntryId(null);
    setTraceId(id);
  };
  const go = (key: SectionKey) => {
    setEntryId(null);
    setTraceId(null);
    setSection(key);
  };
  const openType = (type: string) => {
    setEntryId(null);
    setTraceId(null);
    setEntryPreset({ type, nonce: Date.now() });
    setSection('entries');
  };

  const navigate = (target: PaletteTarget) => {
    if (target.kind === 'section') {
      go(target.key);
    } else if (target.kind === 'entryType') {
      openType(target.type);
    } else {
      setEntryId(null);
      setTraceId(null);
      setDashboardId(target.id);
      setSection('extensions');
    }
  };

  const isDark = (theme ?? 'dark') === 'dark';
  const watchers = watcherTypes(meta.data?.entryTypes);

  return (
    <TooltipProvider>
      <div className="flex min-h-screen bg-background font-mono text-sm text-foreground">
        <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-line px-3 py-4">
          <span className="px-3 text-base font-semibold text-brand">Telescope</span>
          <nav className="flex flex-col gap-1" aria-label="sections">
            {NAV.map((item) => {
              const active = !entryId && !traceId && section === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={navItemClass(active)}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => go(item.key)}
                >
                  {item.label}
                </button>
              );
            })}
            {(meta.data?.dashboards ?? []).map((d) => (
              <button
                key={d.id}
                type="button"
                className={navItemClass(
                  !entryId && !traceId && section === 'extensions' && dashboardId === d.id,
                )}
                onClick={() => {
                  setEntryId(null);
                  setTraceId(null);
                  setDashboardId(d.id);
                  setSection('extensions');
                }}
              >
                {d.label}
              </button>
            ))}
          </nav>
          <nav className="flex flex-col gap-1" aria-label="watchers">
            <span className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Watchers
            </span>
            {watchers.map((type) => (
              <button
                key={type.id}
                type="button"
                className={watcherItemClass(section === 'entries' && entryPreset?.type === type.id)}
                onClick={() => openType(type.id)}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: type.dot }}
                  aria-hidden="true"
                />
                {type.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-end gap-3 border-b border-line px-4 py-2">
            <RetentionIndicator />
            <CommandPalette dashboards={meta.data?.dashboards ?? []} onNavigate={navigate} />
            <Tooltip label="Toggle light / dark">
              <Button
                variant="outline"
                className="normal-case"
                aria-label="toggle theme"
                aria-pressed={!isDark}
                onClick={() => setTheme((t) => ((t ?? 'dark') === 'light' ? 'dark' : 'light'))}
              >
                {isDark ? <MoonIcon /> : <SunIcon />}
                {isDark ? 'Dark' : 'Light'}
              </Button>
            </Tooltip>
            <span
              className="inline-flex items-center gap-1.5 rounded border border-good/30 bg-good/10 px-2.5 py-1 text-xs uppercase tracking-wide text-good"
              title="Telescope is capturing live"
            >
              <span className="live-dot" aria-hidden="true" />
              Live
            </span>
          </header>

          <main className="min-w-0 flex-1 overflow-x-hidden p-4">
            {entryId ? (
              <EntryDetail id={entryId} onOpenTrace={openTrace} onBack={() => setEntryId(null)} />
            ) : traceId ? (
              <TraceDetail
                traceId={traceId}
                onOpenEntry={openEntry}
                onBack={() => setTraceId(null)}
              />
            ) : section === 'overview' ? (
              <OverviewSection
                onOpenTrace={openTrace}
                onOpenEntry={openEntry}
                onOpenQueues={() => go('queues')}
              />
            ) : section === 'pulse' ? (
              <PulseSection onOpenTrace={openTrace} />
            ) : section === 'entries' ? (
              <EntriesSection
                key={entryPreset?.nonce ?? 'default'}
                onOpenEntry={openEntry}
                onOpenTrace={openTrace}
                {...(entryPreset ? { presetType: entryPreset.type } : {})}
              />
            ) : section === 'traces' ? (
              <TracesSection onOpenTrace={openTrace} />
            ) : section === 'exceptions' ? (
              <ExceptionsSection onOpenType={() => go('entries')} />
            ) : section === 'schedules' ? (
              <SchedulesLiveSection />
            ) : section === 'queues' ? (
              <QueueManagerSection />
            ) : section === 'profiles' ? (
              <ProfilesSection />
            ) : section === 'exports' ? (
              <ExportsSection />
            ) : (
              <ExtensionsSection
                selectedId={dashboardId}
                onSelect={setDashboardId}
                onOpenTrace={openTrace}
              />
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
