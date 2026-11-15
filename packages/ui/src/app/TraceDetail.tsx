import { useMemo, useState } from 'react';
import { Button } from '../agora-kit/ui/button';
import { Tabs, TabsList, TabsTrigger } from '../agora-kit/ui/tabs';
import { formatCount, formatDuration, formatRelative } from '../client/format.js';
import type { EntrySummary, NPlusOnePattern, Waterfall, WaterfallSpan } from '../client/types.js';
import { appLabel } from './AppPicker.js';
import { ArrowLeftIcon } from './icons.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, clickable, Panel, SectionTitle, TypeBadge, typeColor } from './ui.js';
import {
  type AsyncState,
  useApps,
  useNPlusOne,
  useTraceEntries,
  useWaterfall,
} from './use-telescope.js';

/** A flat waterfall row (depth-first) carrying the geometry for one bar. */
export interface FlatSpan {
  span: WaterfallSpan;
  leftPct: number;
  widthPct: number;
}

/**
 * Flatten the nested span tree depth-first into rows with pre-computed bar geometry
 * (`left = offsetMs/total`, `width = durationMs/total`, clamped to a visible minimum). Pure +
 * exported for unit testing.
 */
export function flattenWaterfall(waterfall: Waterfall): FlatSpan[] {
  const total = waterfall.totalDurationMs > 0 ? waterfall.totalDurationMs : 1;
  const out: FlatSpan[] = [];
  const walk = (spans: WaterfallSpan[]) => {
    for (const span of spans) {
      const leftPct = Math.max(0, Math.min(100, (span.offsetMs / total) * 100));
      const rawWidth = (span.durationMs / total) * 100;
      const widthPct = Math.max(0.6, Math.min(100 - leftPct, rawWidth));
      out.push({ span, leftPct, widthPct });
      if (span.children.length > 0) walk(span.children);
    }
  };
  walk(waterfall.spans);
  return out;
}

/** The per-trace view: a Waterfall | Entries toggle over one trace. */
export function TraceDetail({
  traceId,
  onOpenEntry,
  onBack,
}: {
  traceId: string;
  onOpenEntry: (id: string) => void;
  onBack: () => void;
}) {
  const [view, setView] = useState<'waterfall' | 'entries' | 'nplusone'>('waterfall');
  const entriesState = useTraceEntries(traceId);
  const userLabel = useMemo(() => {
    const list = entriesState.data ?? [];
    const request = list.find((e) => e.type === 'request' && e.userLabel);
    return request?.userLabel ?? null;
  }, [entriesState.data]);
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit text-dim" onClick={onBack}>
        <ArrowLeftIcon />
        Back to traces
      </Button>
      <Panel>
        <SectionTitle title="Trace" hint={<span className="mono">{traceId.slice(0, 20)}</span>} />
        <p className="mb-3 text-xs text-faint">
          user: <span className="text-fg-2">{userLabel ?? '—'}</span>
        </p>
        <Tabs
          value={view}
          onValueChange={(next: unknown) => {
            if (typeof next === 'string') setView(next as typeof view);
          }}
        >
          <TabsList className="mb-4">
            <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
            <TabsTrigger value="entries">Entries</TabsTrigger>
            <TabsTrigger value="nplusone">N+1</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === 'waterfall' ? (
          <WaterfallView traceId={traceId} onOpenEntry={onOpenEntry} />
        ) : view === 'entries' ? (
          <TraceEntries state={entriesState} onOpenEntry={onOpenEntry} />
        ) : (
          <NPlusOneView traceId={traceId} onOpenEntry={onOpenEntry} />
        )}
      </Panel>
    </div>
  );
}

function NPlusOneView({
  traceId,
  onOpenEntry,
}: {
  traceId: string;
  onOpenEntry: (id: string) => void;
}) {
  const state = useNPlusOne(traceId);
  return (
    <AsyncBlock
      state={state}
      isEmpty={(patterns) => patterns.length === 0}
      empty="No N+1 query loops detected in this trace."
      skeletonRows={4}
    >
      {(patterns: NPlusOnePattern[]) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Query</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead className="text-right">×</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {patterns.map((p) => (
              <TableRow
                key={p.childFamilyHash}
                className="cursor-pointer"
                {...clickable(() => onOpenEntry(p.representativeId))}
              >
                <TableCell
                  className="mono"
                  style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {p.childSql}
                </TableCell>
                <TableCell
                  className="mono text-muted-foreground"
                  style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {p.parentSql ?? '—'}
                </TableCell>
                <TableCell className="tnum text-right">{formatCount(p.count)}</TableCell>
                <TableCell className="tnum text-right">
                  {formatDuration(p.totalDurationMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AsyncBlock>
  );
}

/**
 * Whether the waterfall shows an app column: only when its spans come from more than one app. A
 * single app (standalone, or the one app a viewer may see) has nothing to tell apart.
 */
export function waterfallShowsApps(waterfall: Waterfall): boolean {
  return (waterfall.apps?.length ?? 0) > 1;
}

/** "3 spans in other apps hidden", or `null` when nothing is hidden. */
export function hiddenSpansNote(waterfall: Waterfall): string | null {
  const hidden = waterfall.hiddenSpans ?? 0;
  if (hidden <= 0) return null;
  return `${formatCount(hidden)} ${hidden === 1 ? 'span' : 'spans'} in other apps hidden`;
}

function WaterfallView({
  traceId,
  onOpenEntry,
}: {
  traceId: string;
  onOpenEntry: (id: string) => void;
}) {
  const state = useWaterfall(traceId);
  const apps = useApps().data;
  return (
    <AsyncBlock state={state} empty="No spans in this trace." skeletonRows={6}>
      {(waterfall) => {
        const rows = flattenWaterfall(waterfall);
        const showApps = waterfallShowsApps(waterfall);
        const note = hiddenSpansNote(waterfall);
        return (
          <>
            <div className="mono mb-3 flex items-center justify-between gap-3 text-[11px] text-faint">
              <span>total {formatDuration(waterfall.totalDurationMs)}</span>
              {showApps ? (
                <span data-testid="waterfall-apps">
                  across {(waterfall.apps ?? []).map((id) => appLabel(apps, id)).join(' → ')}
                </span>
              ) : null}
              <span>{rows.length} spans</span>
            </div>
            {note !== null ? (
              <p
                className="mb-3 rounded-md border border-line px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                {note}
              </p>
            ) : null}
            <div className={showApps ? 'waterfall waterfall-apps' : 'waterfall'}>
              {rows.map(({ span, leftPct, widthPct }) => (
                <div key={span.id} className="wf-row" {...clickable(() => onOpenEntry(span.id))}>
                  {showApps ? (
                    <div className="wf-app mono" title={span.app ?? ''}>
                      {span.app !== undefined ? appLabel(apps, span.app) : '—'}
                    </div>
                  ) : null}
                  <div
                    className="wf-label mono"
                    style={{ paddingLeft: span.depth * 14 }}
                    title={span.label}
                  >
                    <span
                      className="swatch"
                      style={{ background: typeColor(span.type), borderRadius: 999 }}
                    />
                    {span.label}
                  </div>
                  <div className="wf-track">
                    <div
                      className="wf-bar"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        color: typeColor(span.type),
                      }}
                    />
                  </div>
                  <div className="wf-dur tnum">{formatDuration(span.durationMs)}</div>
                </div>
              ))}
            </div>
          </>
        );
      }}
    </AsyncBlock>
  );
}

function TraceEntries({
  state,
  onOpenEntry,
}: {
  state: AsyncState<EntrySummary[]>;
  onOpenEntry: (id: string) => void;
}) {
  return (
    <AsyncBlock
      state={state}
      isEmpty={(entries) => entries.length === 0}
      empty="No entries in this trace."
      skeletonRows={5}
    >
      {(entries) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow
                key={e.id}
                className="cursor-pointer"
                {...clickable(() => onOpenEntry(e.id))}
              >
                <TableCell>
                  <TypeBadge type={e.type} />
                </TableCell>
                <TableCell className="mono">{e.summary}</TableCell>
                <TableCell className="tnum text-right">{formatDuration(e.durationMs)}</TableCell>
                <TableCell className="text-muted-foreground" title={e.createdAt}>
                  {formatRelative(e.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AsyncBlock>
  );
}
