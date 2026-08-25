import { useMemo, useState } from 'react';
import { formatCount, formatDuration, formatRelative } from '../client/format.js';
import type { EntrySummary, NPlusOnePattern, Waterfall, WaterfallSpan } from '../client/types.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { Tabs, TabsList, TabsTab } from './primitives/tabs.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge, clickable, typeColor } from './ui.js';
import { type AsyncState, useNPlusOne, useTraceEntries, useWaterfall } from './use-telescope.js';

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
      <button
        type="button"
        className="w-fit border-0 bg-transparent p-0 pb-1 text-[13px] text-brand"
        onClick={onBack}
      >
        ← Back to traces
      </button>
      <Panel>
        <SectionTitle title="Trace" hint={<span className="mono">{traceId.slice(0, 20)}</span>} />
        <p className="mb-3 text-xs text-muted-foreground">
          user: <span className="text-foreground">{userLabel ?? '—'}</span>
        </p>
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (typeof next === 'string') setView(next as typeof view);
          }}
        >
          <TabsList className="mb-4">
            <TabsTab value="waterfall">Waterfall</TabsTab>
            <TabsTab value="entries">Entries</TabsTab>
            <TabsTab value="nplusone">N+1</TabsTab>
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
                className="cursor-pointer hover:bg-brand/5"
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

function WaterfallView({
  traceId,
  onOpenEntry,
}: {
  traceId: string;
  onOpenEntry: (id: string) => void;
}) {
  const state = useWaterfall(traceId);
  return (
    <AsyncBlock state={state} empty="No spans in this trace." skeletonRows={6}>
      {(waterfall) => {
        const rows = flattenWaterfall(waterfall);
        return (
          <>
            <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>total {formatDuration(waterfall.totalDurationMs)}</span>
              <span>{rows.length} spans</span>
            </div>
            <div className="waterfall">
              {rows.map(({ span, leftPct, widthPct }) => (
                <div key={span.id} className="wf-row" {...clickable(() => onOpenEntry(span.id))}>
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
                className="cursor-pointer hover:bg-brand/5"
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
