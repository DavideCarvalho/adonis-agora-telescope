import { useEffect, useState } from 'react';
import { CommandPalette, type PaletteTarget } from './CommandPalette.js';
import { EntriesSection } from './EntriesSection.js';
import { EntryDetail } from './EntryDetail.js';
import { ExceptionsSection } from './ExceptionsSection.js';
import { ExportsSection } from './ExportsSection.js';
import { ExtensionsSection } from './ExtensionsSection.js';
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
import { useMeta } from './use-telescope.js';

type SectionKey =
  | 'pulse'
  | 'entries'
  | 'traces'
  | 'exceptions'
  | 'exports'
  | 'extensions'
  | 'profiles'
  | 'queues'
  | 'schedules';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'pulse', label: 'Pulse' },
  { key: 'entries', label: 'Entries' },
  { key: 'traces', label: 'Traces' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'queues', label: 'Queues' },
  { key: 'profiles', label: 'Profiles' },
  { key: 'exports', label: 'Exports' },
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

/**
 * The dashboard shell: brand, section tabs, command palette, theme toggle, and the active view. A
 * selected entry or trace opens an overlay detail (entry wins over trace), so any list row / trace
 * pill can deep-dive without leaving the section it was opened from.
 *
 * Styling matches `@dudousxd/nestjs-telescope-ui`'s `DashboardLayout` (Tailwind + the Aviary tokens
 * + the vendored Base UI primitives) — the top-tabs page architecture is unchanged (this dashboard
 * has no router), only the visual language.
 */
export function App() {
  const [section, setSection] = useState<SectionKey>('pulse');
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

  const navigate = (target: PaletteTarget) => {
    if (target.kind === 'section') {
      go(target.key);
    } else if (target.kind === 'entryType') {
      setEntryId(null);
      setTraceId(null);
      setEntryPreset({ type: target.type, nonce: Date.now() });
      setSection('entries');
    } else {
      setEntryId(null);
      setTraceId(null);
      setDashboardId(target.id);
      setSection('extensions');
    }
  };

  const isDark = (theme ?? 'dark') === 'dark';

  return (
    <TooltipProvider>
      <div className="app-bg" />
      <div className="relative z-10 mx-auto max-w-[1240px] px-6 pb-16 pt-7">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="mono grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-brand text-sm font-bold text-brand-foreground shadow-[0_6px_20px_-4px_var(--accent)]">
              T
            </div>
            <div>
              <h1 className="m-0 text-[17px] tracking-tight">Telescope</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                @adonis-agora/telescope — observability
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <RetentionIndicator />
            <CommandPalette dashboards={meta.data?.dashboards ?? []} onNavigate={navigate} />
            <Tooltip label="Toggle light / dark">
              <Button
                variant="outline"
                size="icon"
                aria-label="toggle theme"
                aria-pressed={!isDark}
                onClick={() => setTheme((t) => ((t ?? 'dark') === 'light' ? 'dark' : 'light'))}
              >
                {isDark ? <MoonIcon /> : <SunIcon />}
              </Button>
            </Tooltip>
          </div>
        </header>

        <nav className="mb-5 flex flex-wrap gap-1.5" aria-label="sections">
          {SECTIONS.map((s) => {
            const active = !entryId && !traceId && section === s.key;
            return (
              <button
                key={s.key}
                type="button"
                className={
                  active
                    ? 'inline-flex items-center gap-1.5 rounded-full border border-brand bg-brand px-3.5 py-1.5 text-[13px] text-brand-foreground'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground'
                }
                aria-selected={active}
                onClick={() => go(s.key)}
              >
                {s.label}
              </button>
            );
          })}
        </nav>

        <main>
          {entryId ? (
            <EntryDetail id={entryId} onOpenTrace={openTrace} onBack={() => setEntryId(null)} />
          ) : traceId ? (
            <TraceDetail
              traceId={traceId}
              onOpenEntry={openEntry}
              onBack={() => setTraceId(null)}
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

        <div className="mt-6 text-center text-[11px] text-muted-foreground">
          Read-only observability · @adonis-agora/telescope-ui
        </div>
      </div>
    </TooltipProvider>
  );
}
