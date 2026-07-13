import { useState } from 'react';
import { formatDuration, formatRelative } from '../client/format.js';
import type { Waterfall, WaterfallSpan } from '../client/types.js';
import { AsyncBlock, Panel, SectionTitle, TypeBadge, clickable, typeColor } from './ui.js';
import { useTraceEntries, useWaterfall } from './use-telescope.js';

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
  const [view, setView] = useState<'waterfall' | 'entries'>('waterfall');
  return (
    <div className="stack">
      <button type="button" className="back" onClick={onBack}>
        ← Back to traces
      </button>
      <Panel>
        <SectionTitle title="Trace" hint={<span className="mono">{traceId.slice(0, 20)}</span>} />
        <div className="segmented" role="tablist" style={{ marginBottom: 16 }}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'waterfall'}
            onClick={() => setView('waterfall')}
          >
            Waterfall
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'entries'}
            onClick={() => setView('entries')}
          >
            Entries
          </button>
        </div>
        {view === 'waterfall' ? (
          <WaterfallView traceId={traceId} onOpenEntry={onOpenEntry} />
        ) : (
          <TraceEntries traceId={traceId} onOpenEntry={onOpenEntry} />
        )}
      </Panel>
    </div>
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
            <div className="section-title">
              <span className="muted">total {formatDuration(waterfall.totalDurationMs)}</span>
              <span className="hint">{rows.length} spans</span>
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
  traceId,
  onOpenEntry,
}: {
  traceId: string;
  onOpenEntry: (id: string) => void;
}) {
  const state = useTraceEntries(traceId);
  return (
    <AsyncBlock
      state={state}
      isEmpty={(entries) => entries.length === 0}
      empty="No entries in this trace."
      skeletonRows={5}
    >
      {(entries) => (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Summary</th>
                <th className="num">Duration</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="row-link" {...clickable(() => onOpenEntry(e.id))}>
                  <td>
                    <TypeBadge type={e.type} />
                  </td>
                  <td className="mono">{e.summary}</td>
                  <td className="num tnum">{formatDuration(e.durationMs)}</td>
                  <td className="muted" title={e.createdAt}>
                    {formatRelative(e.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AsyncBlock>
  );
}
