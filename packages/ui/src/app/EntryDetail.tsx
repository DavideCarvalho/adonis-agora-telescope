import { useState } from 'react';
import { formatDuration, formatTime } from '../client/format.js';
import type {
  DiagnoseOutcome,
  Entry,
  ReplayOutcome,
  RequestEntryContent,
} from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge } from './ui.js';
import { useEntry, useMeta, useTelescopeClient } from './use-telescope.js';

const CODE_CLASS =
  'm-0 mt-3 max-w-full overflow-x-auto whitespace-pre rounded-lg border border-line bg-background p-3.5 font-mono text-xs leading-relaxed text-foreground';

/** The full entry view: type-aware header, a metadata list, and the pretty-printed `content`. Plus,
 *  for exception/client_exception entries, the AI diagnosis panel, and for `request` entries, the
 *  replay action — both additive to the NestJS-parity layout above them. */
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
  const meta = useMeta();

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        className="w-fit border-0 bg-transparent p-0 pb-1 text-[13px] text-brand"
        onClick={onBack}
      >
        ← Back to entries
      </button>
      <AsyncBlock state={state} empty="Entry not found." skeletonRows={5}>
        {(entry) => (
          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Panel>
              <SectionTitle title="Content" hint={<TypeBadge type={entry.type} />} />
              {isRequest(entry) && <RequestHeader content={entry.content as RequestEntryContent} />}
              <pre className={CODE_CLASS}>{stringify(entry.content)}</pre>
              {isException(entry) && (
                <DiagnosePanel entryId={entry.id} aiEnabled={meta.data?.ai?.enabled ?? false} />
              )}
              {entry.type === 'request' && <ReplayPanel entryId={entry.id} />}
            </Panel>

            <Panel>
              <SectionTitle title="Details" />
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-muted-foreground">ID</dt>
                <dd className="mono m-0 break-words">{entry.id}</dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd className="m-0">{entry.type}</dd>
                <dt className="text-muted-foreground">Family</dt>
                <dd className="mono m-0 break-words">{entry.familyHash ?? '—'}</dd>
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="tnum m-0">{formatDuration(entry.durationMs)}</dd>
                <dt className="text-muted-foreground">Sequence</dt>
                <dd className="tnum m-0">{entry.sequence}</dd>
                <dt className="text-muted-foreground">Origin</dt>
                <dd className="m-0">{entry.origin}</dd>
                <dt className="text-muted-foreground">Recorded</dt>
                <dd className="m-0" title={entry.createdAt}>
                  {formatTime(entry.createdAt)}
                </dd>
                <dt className="text-muted-foreground">Trace</dt>
                <dd className="m-0">
                  {entry.traceId ? (
                    <button
                      type="button"
                      className="border-0 bg-transparent p-0 text-xs text-brand"
                      onClick={() => onOpenTrace(entry.traceId as string)}
                    >
                      {entry.traceId.slice(0, 12)} · view trace →
                    </button>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt className="text-muted-foreground">User</dt>
                <dd className="m-0">{entryUserLabel(entry) ?? '—'}</dd>
              </dl>
              {entry.tags.length > 0 && (
                <div className="mt-3.5 flex flex-wrap gap-1">
                  {entry.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
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

/** The captured authenticated user's label (`email` ?? `id`), when the entry's content carried one. */
function entryUserLabel(entry: Entry): string | null {
  const content = entry.content as { user?: { id?: string; email?: string } | null } | null;
  const user = content?.user;
  if (!user) return null;
  return user.email ?? user.id ?? null;
}

function isException(entry: Entry): boolean {
  return entry.type === 'exception' || entry.type === 'client_exception';
}

function RequestHeader({ content }: { content: RequestEntryContent }) {
  const status = content.status;
  const variant =
    status === null ? 'outline' : status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'good';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="mono">
        {content.method}
      </Badge>
      <span className="mono text-xs">{content.url}</span>
      <Badge variant={variant} className="mono">
        {status ?? '—'}
      </Badge>
      <span className="tnum text-xs text-muted-foreground">
        {formatDuration(content.durationMs)}
      </span>
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

// ── AI exception diagnosis ────────────────────────────────────────────────

/**
 * "AI diagnosis" panel for exception/client_exception details, visible only when
 * `meta.ai.enabled` (the host configured `@adonis-agora/telescope/ai`). Matches
 * `@dudousxd/nestjs-telescope-ui`'s `entry-detail.tsx` `DiagnosePanel` — same placement (a bordered
 * block under the raw content), same button progression ("Diagnose with AI" → "Re-run"), same
 * markdown rendering — with one deliberate divergence: `DiagnosisCoordinator` here has no
 * side-effect-free "peek cached" verb, so there's no mount-time auto-fetch; the panel always starts
 * at the "Diagnose with AI" button rather than possibly showing an auto-mode diagnosis on open.
 */
function DiagnosePanel({ entryId, aiEnabled }: { entryId: string; aiEnabled: boolean }) {
  const client = useTelescopeClient();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiagnoseOutcome | null>(null);

  if (!aiEnabled) return null;

  async function run(force: boolean): Promise<void> {
    setPending(true);
    try {
      setResult(await client.diagnoseException(entryId, force));
    } finally {
      setPending(false);
    }
  }

  const isCached = result?.ok && result.cached;

  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          AI diagnosis
          {isCached && (
            <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] normal-case text-warn">
              cached
            </span>
          )}
        </h3>
        {result !== null ? (
          <Button variant="outline" size="xs" onClick={() => run(true)} disabled={pending}>
            {pending ? 'Re-running…' : 'Re-run'}
          </Button>
        ) : (
          <Button variant="brand" size="xs" onClick={() => run(false)} disabled={pending}>
            {pending ? 'Diagnosing…' : 'Diagnose with AI'}
          </Button>
        )}
      </div>
      {pending ? (
        <p className="text-xs text-muted-foreground">Asking the model…</p>
      ) : result !== null ? (
        result.ok ? (
          <Markdown source={result.markdown} />
        ) : (
          <p className="rounded bg-panel p-3 text-xs text-bad">{result.message}</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Get an AI-generated probable cause, where to look, and a suggested fix.
        </p>
      )}
    </div>
  );
}

/**
 * Lightweight markdown renderer, ported verbatim from `entry-detail.tsx`'s `Markdown` in
 * `@dudousxd/nestjs-telescope-ui` — the UI deps carry no markdown library, and the diagnosis output
 * is a small, fixed-shape document (`## ` headings + paragraphs/bullets).
 */
type MarkdownBlock =
  | { id: string; kind: 'heading'; text: string }
  | { id: string; kind: 'paragraph'; text: string }
  | { id: string; kind: 'bullets'; items: { id: string; text: string }[] };

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let bullets: { id: string; text: string }[] = [];
  let counter = 0;
  const nextId = (): string => `block-${counter++}`;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    blocks.push({ id: nextId(), kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  }
  function flushBullets(): void {
    if (bullets.length === 0) return;
    blocks.push({ id: nextId(), kind: 'bullets', items: bullets });
    bullets = [];
  }

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      flushBullets();
      blocks.push({ id: nextId(), kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') });
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      bullets.push({ id: nextId(), text: line.replace(/^[-*]\s+/, '') });
    } else if (line.trim() === '') {
      flushParagraph();
      flushBullets();
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();
  return blocks;
}

function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className="rounded bg-panel p-3">
      {blocks.map((block) => {
        if (block.kind === 'heading') {
          return (
            <h4 key={block.id} className="mb-1 mt-3 text-xs font-semibold text-brand first:mt-0">
              {block.text}
            </h4>
          );
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={block.id} className="ml-4 list-disc text-xs leading-relaxed text-foreground">
              {block.items.map((item) => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={block.id} className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

// ── request replay ──────────────────────────────────────────────────────────

/**
 * "Replay" action for `request` entries — re-issues the captured request against the live server via
 * `POST /requests/:id/replay` (backend already wired; this panel is the only missing piece). No
 * NestJS equivalent exists to mirror (confirmed: `packages/ui` there never built a replay UI for its
 * own — differently-shaped — replay route), so this layout follows the AI diagnosis panel's shape
 * for visual consistency within this dashboard: a bordered block, an action button, a result area.
 *
 * Always visible on request entries (unlike `DiagnosePanel`, which is meta-gated) because the
 * disabled-by-default posture is enforced server-side (`403`) and surfaced as the failure message,
 * not hidden — an operator who expects replay to work should see WHY it doesn't rather than a
 * vanished button.
 */
function ReplayPanel({ entryId }: { entryId: string }) {
  const client = useTelescopeClient();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ReplayOutcome | null>(null);

  async function run(): Promise<void> {
    setPending(true);
    try {
      setResult(await client.replayRequest(entryId));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Replay</h3>
        <Button variant="outline" size="xs" onClick={run} disabled={pending}>
          {pending ? 'Replaying…' : 'Replay request'}
        </Button>
      </div>
      {pending ? (
        <p className="text-xs text-muted-foreground">
          Re-issuing the request against the live server…
        </p>
      ) : result !== null ? (
        result.ok ? (
          <div className="rounded bg-panel p-3 text-xs">
            <div className="mono flex items-center gap-3">
              <span className={cn(statusToneClass(result.status))}>{result.status}</span>
              <span className="tnum text-muted-foreground">{result.durationMs}ms</span>
            </div>
            {result.error && <p className="mt-2 text-bad">{result.error}</p>}
            {result.body && <pre className={cn(CODE_CLASS, 'max-h-48')}>{result.body}</pre>}
          </div>
        ) : (
          <p className="rounded bg-panel p-3 text-xs text-bad">{result.message}</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Re-issue this captured request against the live server and inspect the outcome.
        </p>
      )}
    </div>
  );
}

function statusToneClass(status: number): string {
  if (status >= 500) return 'text-bad';
  if (status >= 400) return 'text-warn';
  return 'text-good';
}
