import { useEffect, useState } from 'react';
import { EntriesSection } from './EntriesSection.js';
import { EntryDetail } from './EntryDetail.js';
import { ExceptionsSection } from './ExceptionsSection.js';
import { PulseSection } from './PulseSection.js';
import { TraceDetail } from './TraceDetail.js';
import { TracesSection } from './TracesSection.js';

type SectionKey = 'pulse' | 'entries' | 'traces' | 'exceptions';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'pulse', label: 'Pulse' },
  { key: 'entries', label: 'Entries' },
  { key: 'traces', label: 'Traces' },
  { key: 'exceptions', label: 'Exceptions' },
];

/**
 * The dashboard shell: brand, section tabs, theme toggle, and the active view. A selected entry or
 * trace opens an overlay detail (entry wins over trace), so any list row / trace pill can deep-dive
 * without leaving the section it was opened from.
 */
export function App() {
  const [section, setSection] = useState<SectionKey>('pulse');
  const [entryId, setEntryId] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
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

  return (
    <>
      <div className="app-bg" />
      <div className="shell">
        <header className="masthead">
          <div className="brand">
            <div className="brand-mark mono">T</div>
            <div>
              <h1>Telescope</h1>
              <p>@adonis-agora/telescope — observability</p>
            </div>
          </div>
          <div className="controls">
            <button
              type="button"
              className="icon-btn"
              aria-label="toggle theme"
              title="Toggle light / dark"
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            >
              {theme === 'light' ? '☾' : '☀'}
            </button>
          </div>
        </header>

        <nav className="tabs" aria-label="sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="tab"
              aria-selected={!entryId && !traceId && section === s.key}
              onClick={() => go(s.key)}
            >
              {s.label}
            </button>
          ))}
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
            <EntriesSection onOpenEntry={openEntry} onOpenTrace={openTrace} />
          ) : section === 'traces' ? (
            <TracesSection onOpenTrace={openTrace} />
          ) : (
            <ExceptionsSection onOpenType={() => go('entries')} />
          )}
        </main>

        <div className="foot">Read-only observability · @adonis-agora/telescope-ui</div>
      </div>
    </>
  );
}
