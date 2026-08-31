import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type {
  BreakdownPanelData,
  DashboardSection,
  DashboardSpec,
  DistributionPanelData,
  GaugePanelData,
  Panel,
  StatPanelData,
  TablePanelData,
  TimeseriesPanelData,
  TopNPanelData,
} from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { cn } from './primitives/cn.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, Panel as Card, SectionTitle, ShareBar, Sparkline } from './ui.js';
import { useExtensionData, useMeta } from './use-telescope.js';

/** The owning extension's namespace is the dashboard id's prefix before the first `.`
 *  (the convention every built dashboard id follows, e.g. `durable.workflows` → `durable`). */
function extensionOf(dashboardId: string): string {
  const dot = dashboardId.indexOf('.');
  return dot === -1 ? dashboardId : dashboardId.slice(0, dot);
}

function formatByKind(value: number, format?: string): string {
  switch (format) {
    case 'percent':
      return formatPercent(value);
    case 'duration':
      return formatDuration(value);
    case 'rate':
      return `${formatCount(value)}/s`;
    default:
      return formatCount(value);
  }
}

/** Responsive grid column class per section `cols` value — matches
 *  `@dudousxd/nestjs-telescope-ui`'s `colClass` in `extension-dashboard-page.tsx`. */
const SECTION_COLS: Record<2 | 3 | 4, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 lg:grid-cols-4',
};

/**
 * The extension dashboard console: a picker over every `DashboardSpec` an installed extension
 * contributed at boot, rendering its declarative panel layout. Gracefully empty when no
 * extension is installed (the backend `/meta` route itself is only registered when at least one
 * is, and `TelescopeClient.meta()` normalizes a 404 there to `{ entryTypes: [], dashboards: [] }`).
 */
export function ExtensionsSection({
  selectedId,
  onSelect,
  onOpenTrace,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const state = useMeta();

  return (
    <div className="flex flex-col gap-4">
      <SectionTitle title="Extensions" hint="dashboards contributed by installed extensions" />
      <AsyncBlock
        state={state}
        isEmpty={(meta) => meta.dashboards.length === 0}
        empty="No extension dashboards registered."
        skeletonRows={4}
      >
        {(meta) => (
          <ExtensionsBody
            dashboards={meta.dashboards}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenTrace={onOpenTrace}
          />
        )}
      </AsyncBlock>
    </div>
  );
}

function ExtensionsBody({
  dashboards,
  selectedId,
  onSelect,
  onOpenTrace,
}: {
  dashboards: DashboardSpec[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const active = dashboards.find((d) => d.id === selectedId) ?? dashboards[0];

  // Auto-sync only when a specific dashboard was actually selected (non-null). With `selectedId ===
  // null` the "first dashboard" is a render default (`?? dashboards[0]` above), not a navigation
  // action — the URL must stay `#/extensions` so browser Back isn't polluted. A non-null id that no
  // longer exists still re-syncs to the first dashboard.
  useEffect(() => {
    if (selectedId !== null && active && active.id !== selectedId) onSelect(active.id);
  }, [active, selectedId, onSelect]);

  if (!active) return null;

  const sections: DashboardSection[] =
    active.sections && active.sections.length > 0
      ? active.sections
      : [{ cols: 2, panels: active.panels }];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {dashboards.map((d) => {
            const isActive = d.id === active.id;
            return (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelect(d.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px]',
                  isActive
                    ? 'border-brand bg-brand text-brand-foreground'
                    : 'border-line bg-panel text-muted-foreground transition-colors hover:text-foreground',
                )}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </Card>
      {sections.map((section) => (
        <Card key={section.title ?? `section-${section.panels.map((p) => p.title).join('|')}`}>
          {section.title && <SectionTitle title={section.title} />}
          <div className={cn('grid grid-cols-1 gap-4', SECTION_COLS[section.cols ?? 2])}>
            {section.panels.map((panel) => (
              <PanelView
                key={`${panel.kind}-${panel.title}`}
                ext={extensionOf(active.id)}
                panel={panel}
                onOpenTrace={onOpenTrace}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function PanelView({
  ext,
  panel,
  onOpenTrace,
}: {
  ext: string;
  panel: Panel;
  onOpenTrace: (traceId: string) => void;
}) {
  switch (panel.kind) {
    case 'stat':
      return <StatPanel ext={ext} panel={panel} />;
    case 'timeseries':
      return <TimeseriesPanel ext={ext} panel={panel} />;
    case 'topN':
      return <TopNPanel ext={ext} panel={panel} />;
    case 'table':
      return <TablePanel ext={ext} panel={panel} onOpenTrace={onOpenTrace} />;
    case 'distribution':
      return <DistributionPanel ext={ext} panel={panel} />;
    case 'gauge':
      return <GaugePanel ext={ext} panel={panel} />;
    case 'breakdown':
      return <BreakdownPanel ext={ext} panel={panel} />;
    default:
      return null;
  }
}

function PanelFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <SectionTitle title={title} />
      {children}
    </Card>
  );
}

function StatPanel({ ext, panel }: { ext: string; panel: Extract<Panel, { kind: 'stat' }> }) {
  const state = useExtensionData<StatPanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock state={state} empty="No data." skeletonRows={2}>
        {(data) => (
          <div className="flex flex-col gap-2">
            <div className="mono tnum text-2xl font-semibold tracking-tight">
              {formatByKind(data.value, panel.format)}
            </div>
            {data.delta !== undefined && (
              <div className={cn('text-xs', data.delta >= 0 ? 'text-good' : 'text-bad')}>
                {data.delta >= 0 ? '▲' : '▼'} {formatByKind(Math.abs(data.delta), panel.format)}
                {panel.data.query?.deltaLabel ? ` ${String(panel.data.query.deltaLabel)}` : ''}
              </div>
            )}
            {panel.spark && data.spark && data.spark.length > 0 && (
              <Sparkline values={data.spark} width={220} height={32} />
            )}
          </div>
        )}
      </AsyncBlock>
    </PanelFrame>
  );
}

function TimeseriesPanel({
  ext,
  panel,
}: {
  ext: string;
  panel: Extract<Panel, { kind: 'timeseries' }>;
}) {
  const state = useExtensionData<TimeseriesPanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock
        state={state}
        isEmpty={(d) => d.rows.length === 0}
        empty="No data."
        skeletonRows={3}
      >
        {(data) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                {panel.series.map((s) => (
                  <TableHead key={s} className="text-right">
                    {s}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.slice(-12).map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="mono text-muted-foreground">{row.label}</TableCell>
                  {panel.series.map((s) => (
                    <TableCell key={s} className="tnum text-right">
                      {formatCount(typeof row[s] === 'number' ? (row[s] as number) : 0)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AsyncBlock>
    </PanelFrame>
  );
}

function TopNPanel({ ext, panel }: { ext: string; panel: Extract<Panel, { kind: 'topN' }> }) {
  const state = useExtensionData<TopNPanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock
        state={state}
        isEmpty={(d) => d.items.length === 0}
        empty="No data."
        skeletonRows={3}
      >
        {(data) => {
          const items = panel.limit ? data.items.slice(0, panel.limit) : data.items;
          const max = Math.max(1, ...items.map((i) => i.value));
          return (
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <div key={item.id ?? item.label} className="flex items-center gap-2">
                  <span className="mono flex-[0_0_40%] overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.label}
                  </span>
                  <ShareBar fraction={item.value / max} />
                  <span className="tnum w-[60px] text-right text-muted-foreground">
                    {formatCount(item.value)}
                  </span>
                </div>
              ))}
            </div>
          );
        }}
      </AsyncBlock>
    </PanelFrame>
  );
}

function TablePanel({
  ext,
  panel,
  onOpenTrace,
}: {
  ext: string;
  panel: Extract<Panel, { kind: 'table' }>;
  onOpenTrace: (traceId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const limit = 25;
  const query = useMemo(() => {
    const base = asQuery(panel.data.query);
    return panel.paged ? { ...base, page: String(page), limit: String(limit) } : base;
  }, [panel.data.query, panel.paged, page]);
  const state = useExtensionData<TablePanelData>(ext, panel.data.provider, query);

  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock
        state={state}
        isEmpty={(d) => d.rows.length === 0}
        empty="No rows."
        skeletonRows={4}
      >
        {(data) => {
          const totalPages =
            panel.paged && data.total !== undefined
              ? Math.max(1, Math.ceil(data.total / limit))
              : 1;
          return (
            <div className="flex flex-col gap-2.5">
              <Table>
                <TableHeader>
                  <TableRow>
                    {panel.columns.map((col) => (
                      <TableHead key={col.key}>{col.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: provider rows have no guaranteed id.
                    <TableRow key={i}>
                      {panel.columns.map((col) => (
                        <TableCell key={col.key} className="mono">
                          {renderCell(row, col, onOpenTrace)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {panel.paged && (
                <div className="flex items-center justify-end gap-2.5">
                  <Button
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ← Prev
                  </Button>
                  <span className="tnum text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next →
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </AsyncBlock>
    </PanelFrame>
  );
}

function renderCell(
  row: Record<string, unknown>,
  col: { key: string; link?: { href: string; external?: boolean } },
  onOpenTrace: (traceId: string) => void,
): ReactNode {
  const raw = row[col.key];
  const value = raw === null || raw === undefined ? '—' : String(raw);
  if (!col.link) return value;
  const href = fillTemplate(col.link.href, row);
  if (href === null) return value;
  // In-app hash route to a trace waterfall (`#/traces/{traceId}` convention) — open inline
  // instead of a real navigation, since this SPA has no router.
  const traceMatch = /^#\/traces\/(.+)$/.exec(href);
  if (traceMatch?.[1]) {
    const traceId = traceMatch[1];
    return (
      <button
        type="button"
        className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-brand"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTrace(traceId);
        }}
      >
        {value} →
      </button>
    );
  }
  if (/^(javascript|data|vbscript):/i.test(href)) return value;
  return (
    <a
      className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-brand"
      href={href}
      target={col.link.external ? '_blank' : undefined}
      rel="noreferrer"
    >
      {value} →
    </a>
  );
}

/** Substitute `{key}` placeholders in a link template from the row. Refuses an unresolved
 *  placeholder (missing column) rather than leaving a literal `{key}` in the href. */
function fillTemplate(template: string, row: Record<string, unknown>): string | null {
  let ok = true;
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = row[key];
    if (value === undefined || value === null) {
      ok = false;
      return '';
    }
    return encodeURIComponent(String(value));
  });
  return ok ? filled : null;
}

function DistributionPanel({
  ext,
  panel,
}: {
  ext: string;
  panel: Extract<Panel, { kind: 'distribution' }>;
}) {
  const state = useExtensionData<DistributionPanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock
        state={state}
        isEmpty={(d) => d.buckets.length === 0}
        empty="No data."
        skeletonRows={3}
      >
        {(data) => {
          const max = Math.max(1, ...data.buckets.map((b) => b.count));
          const fmt = (v: number) =>
            panel.format === 'number' ? formatCount(v) : formatDuration(v);
          return (
            <div className="flex flex-col gap-2">
              {(panel.markers ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {panel.markers?.includes('p50') && data.p50 !== undefined && (
                    <Badge variant="outline" className="mono tnum">
                      p50 {fmt(data.p50)}
                    </Badge>
                  )}
                  {panel.markers?.includes('p95') && data.p95 !== undefined && (
                    <Badge variant="outline" className="mono tnum">
                      p95 {fmt(data.p95)}
                    </Badge>
                  )}
                  {panel.markers?.includes('p99') && data.p99 !== undefined && (
                    <Badge variant="outline" className="mono tnum">
                      p99 {fmt(data.p99)}
                    </Badge>
                  )}
                </div>
              )}
              {data.buckets.map((b) => (
                <div key={b.label} className="flex items-center gap-2">
                  <span className="mono w-[90px] text-muted-foreground">{b.label}</span>
                  <ShareBar fraction={b.count / max} />
                  <span className="tnum w-[50px] text-right text-muted-foreground">
                    {formatCount(b.count)}
                  </span>
                </div>
              ))}
            </div>
          );
        }}
      </AsyncBlock>
    </PanelFrame>
  );
}

function GaugePanel({ ext, panel }: { ext: string; panel: Extract<Panel, { kind: 'gauge' }> }) {
  const state = useExtensionData<GaugePanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock state={state} empty="No data." skeletonRows={2}>
        {(data) => {
          const min = data.min ?? panel.min ?? 0;
          const max = data.max ?? panel.max ?? 100;
          const fraction = max > min ? (data.value - min) / (max - min) : 0;
          const color =
            panel.thresholds &&
            (panel.thresholds.direction === 'up-bad'
              ? data.value >= panel.thresholds.bad
                ? 'var(--bad)'
                : data.value >= panel.thresholds.warn
                  ? 'var(--warn)'
                  : undefined
              : data.value <= panel.thresholds.bad
                ? 'var(--bad)'
                : data.value <= panel.thresholds.warn
                  ? 'var(--warn)'
                  : undefined);
          return (
            <div className="flex flex-col gap-2">
              <div className="mono tnum text-[22px] font-semibold tracking-tight">
                {formatByKind(data.value, panel.format)}
              </div>
              <ShareBar fraction={fraction} {...(color ? { color } : {})} />
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{formatByKind(min, panel.format)}</span>
                <span className="text-muted-foreground">{formatByKind(max, panel.format)}</span>
              </div>
            </div>
          );
        }}
      </AsyncBlock>
    </PanelFrame>
  );
}

function BreakdownPanel({
  ext,
  panel,
}: {
  ext: string;
  panel: Extract<Panel, { kind: 'breakdown' }>;
}) {
  const state = useExtensionData<BreakdownPanelData>(
    ext,
    panel.data.provider,
    asQuery(panel.data.query),
  );
  return (
    <PanelFrame title={panel.title}>
      <AsyncBlock
        state={state}
        isEmpty={(d) => d.segments.length === 0}
        empty="No data."
        skeletonRows={3}
      >
        {(data) => {
          const total = data.segments.reduce((sum, s) => sum + s.value, 0) || 1;
          return (
            <div className="flex flex-col gap-2">
              {data.segments.map((seg) => (
                <div key={seg.label} className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: seg.color ?? 'var(--accent)' }}
                  />
                  <span className="mono flex-1">{seg.label}</span>
                  <span className="tnum text-muted-foreground">
                    {formatCount(seg.value)} · {formatPercent(seg.value / total)}
                  </span>
                </div>
              ))}
            </div>
          );
        }}
      </AsyncBlock>
    </PanelFrame>
  );
}

/** Merge a panel's static `data.query` into a flat string-record for the client's query string. */
function asQuery(query: Record<string, unknown> | undefined): Record<string, string> {
  if (!query) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}
