import { formatDuration, formatTime } from '../client/format.js';
import type { Entry, RequestEntryContent } from '../client/types.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge } from './ui.js';
import { useEntry } from './use-telescope.js';

/** The full entry view: type-aware header, a metadata list, and the pretty-printed `content`. */
export function EntryDetail({
  id,
  onOpenTrace,
  onBack,
}: {
  id: string;
  onOpenTrace: (traceId: string) => void;
  onBack: () => void;
}) {
  const state = useEntry(id);

  return (
    <div className="stack">
      <button type="button" className="back" onClick={onBack}>
        ← Back to entries
      </button>
      <AsyncBlock state={state} empty="Entry not found." skeletonRows={5}>
        {(entry) => (
          <div className="grid detail">
            <Panel>
              <SectionTitle title="Content" hint={<TypeBadge type={entry.type} />} />
              {isRequest(entry) && <RequestHeader content={entry.content as RequestEntryContent} />}
              <pre className="code">{stringify(entry.content)}</pre>
            </Panel>

            <Panel>
              <SectionTitle title="Details" />
              <dl className="meta">
                <dt>ID</dt>
                <dd className="mono">{entry.id}</dd>
                <dt>Type</dt>
                <dd>{entry.type}</dd>
                <dt>Family</dt>
                <dd className="mono">{entry.familyHash ?? '—'}</dd>
                <dt>Duration</dt>
                <dd className="tnum">{formatDuration(entry.durationMs)}</dd>
                <dt>Sequence</dt>
                <dd className="tnum">{entry.sequence}</dd>
                <dt>Origin</dt>
                <dd>{entry.origin}</dd>
                <dt>Recorded</dt>
                <dd title={entry.createdAt}>{formatTime(entry.createdAt)}</dd>
                <dt>Trace</dt>
                <dd>
                  {entry.traceId ? (
                    <button
                      type="button"
                      className="tag link"
                      onClick={() => onOpenTrace(entry.traceId as string)}
                    >
                      {entry.traceId.slice(0, 12)} · view trace →
                    </button>
                  ) : (
                    '—'
                  )}
                </dd>
              </dl>
              {entry.tags.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {entry.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </AsyncBlock>
    </div>
  );
}

function isRequest(entry: Entry): boolean {
  return entry.type === 'request' && typeof entry.content === 'object' && entry.content !== null;
}

function RequestHeader({ content }: { content: RequestEntryContent }) {
  const status = content.status;
  const cls = status === null ? 'muted' : status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'good';
  return (
    <div className="controls" style={{ marginBottom: 12, gap: 8 }}>
      <span className="pill mono">{content.method}</span>
      <span className="mono">{content.url}</span>
      <span className={`pill mono ${cls}`}>{status ?? '—'}</span>
      <span className="muted tnum">{formatDuration(content.durationMs)}</span>
    </div>
  );
}

/** Pretty-print any JSON content; fall back to `String()` for a non-serializable value. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
