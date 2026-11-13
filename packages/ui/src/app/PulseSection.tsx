import { useState } from 'react';
import { MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { PulseSummary } from '../client/types.js';
import { cn } from './primitives/cn.js';
import { Table, TableBody, TableCell, TableRow } from './primitives/table.js';
import {
  AsyncBlock,
  clickable,
  Empty,
  PageHeader,
  Panel,
  SectionTitle,
  ShareBar,
  Skeleton,
  Sparkline,
  Stat,
  StatGrid,
  typeLabel,
  typeStyle,
  WatcherOff,
} from './ui.js';
import { usePulse, useWatcherEnabled } from './use-telescope.js';
import { WindowSelect } from './WindowSelect.js';

/**
 * The Pulse "at a glance" health overview, straight from the core `getHealth` rollup: headline
 * throughput / error-rate stats, a throughput sparkline, the HTTP status breakdown, and top-N cards
 * for slowest entries, slow routes, exceptions, N+1 hotspots, load-by-user, and cache hit ratio.
 */
export function PulseSection({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const state = usePulse(windowMs);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Pulse"
        description="Health over one window: throughput, errors, latency and the hotspots behind them."
        actions={<WindowSelect value={windowMs} onChange={setWindowMs} />}
      />
      <AsyncBlock state={state} empty="No data in this window." skeleton={<PulseSkeleton />}>
        {(pulse) => <PulseBody pulse={pulse} onOpenTrace={onOpenTrace} />}
      </AsyncBlock>
    </div>
  );
}

function PulseBody({
  pulse,
  onOpenTrace,
}: {
  pulse: PulseSummary;
  onOpenTrace: (traceId: string) => void;
}) {
  // Estes dois painéis derivam de watchers OPCIONAIS. Sem eles não há o que
  // detectar, e "nenhum detectado" afirmaria saúde a partir de cegueira.
  const queryWatcher = useWatcherEnabled('query');
  const httpClientWatcher = useWatcherEnabled('http-client');
  const errorClass =
    pulse.requests.errorRate >= 0.05
      ? 'text-bad'
      : pulse.requests.errorRate > 0
        ? 'text-warn'
        : 'text-good';
  const throughputSeries = pulse.throughput.overTime.buckets.map((b) => b.total);

  return (
    <div className="flex flex-col gap-4">
      <StatGrid>
        <Stat
          label="Throughput"
          value={formatCount(pulse.throughput.total)}
          sub={`${pulse.throughput.perMinute.toFixed(1)}/min`}
        />
        <Stat
          label="Error rate"
          value={<span className={errorClass}>{formatPercent(pulse.requests.errorRate)}</span>}
          sub={`${formatCount(pulse.requests.total)} requests`}
        />
        <Stat
          label="p99 latency"
          value={formatDuration(pulse.requests.latency?.p99 ?? null)}
          sub={`p50 ${formatDuration(pulse.requests.latency?.p50 ?? null)}`}
        />
        <Stat
          label="Scanned"
          value={formatCount(pulse.scanned)}
          sub={pulse.truncated ? 'truncated' : 'complete'}
        />
      </StatGrid>

      <Panel>
        <SectionTitle title="Throughput by type" hint={`${throughputSeries.length} buckets`} />
        <Sparkline values={throughputSeries} width={1180} height={64} />
      </Panel>

      <Panel>
        <SectionTitle title="Entries by type" />
        <EntriesByType counts={pulse.counts} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <SectionTitle title="HTTP status" />
          <StatusBars status={pulse.requests.status} total={pulse.requests.total} />
        </Panel>

        <Panel>
          <SectionTitle title="Slowest" hint="across all types" />
          <HotspotList
            rows={pulse.slowest.map((s) => ({
              key: s.id,
              label: s.label,
              right: formatDuration(s.durationMs),
              traceId: s.traceId,
            }))}
            empty="Nothing slow."
            onOpenTrace={onOpenTrace}
          />
        </Panel>

        <Panel>
          <SectionTitle title="Slow routes" hint="by p99" />
          <HotspotList
            rows={pulse.slowRoutes.map((r) => ({
              key: r.route,
              label: r.route,
              right: `${formatDuration(r.p99)} · ×${r.count}`,
            }))}
            empty="No slow routes."
          />
        </Panel>

        <Panel>
          <SectionTitle title="Top exceptions" />
          <HotspotList
            rows={pulse.topExceptions.map((e) => ({
              key: e.key,
              label: `${e.class}: ${e.message}`,
              right: `×${formatCount(e.count)}`,
            }))}
            empty="No exceptions. 🎉"
          />
        </Panel>

        <Panel>
          <SectionTitle title="N+1 hotspots" hint="by wasted time" />
          {queryWatcher === false ? (
            <WatcherOff watcher="query" config="config/telescope_watchers.ts" />
          ) : (
            <HotspotList
              rows={pulse.nPlusOne.map((n) => ({
                key: n.familyHash,
                label: n.sql,
                right: `×${n.perRequest} · ${formatDuration(n.totalDurationMs)}`,
                traceId: n.sampleTraceId,
              }))}
              empty="No N+1 loops detected."
              onOpenTrace={onOpenTrace}
            />
          )}
        </Panel>

        <Panel>
          <SectionTitle title="Load by user" />
          <HotspotList
            rows={pulse.loadByUser.map((u) => ({
              key: u.user,
              label: u.user,
              right: `${formatCount(u.count)} · ${formatDuration(u.totalDurationMs)}`,
            }))}
            empty="No per-user load."
          />
        </Panel>

        <Panel>
          <SectionTitle title="Slow outgoing HTTP" hint="by p99" />
          {httpClientWatcher === false ? (
            <WatcherOff watcher="http-client" config="config/telescope_watchers.ts" />
          ) : (
            <HotspotList
              rows={pulse.slowOutgoing.map((r) => ({
                key: r.route,
                label: r.route,
                right: `${formatDuration(r.p99)} · ×${r.count}`,
              }))}
              empty="No slow outgoing calls."
            />
          )}
        </Panel>
      </div>

      {pulse.cache && (
        <Panel>
          <SectionTitle title="Cache" hint={`hit ratio ${formatPercent(pulse.cache.hitRatio)}`} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Hits" value={formatCount(pulse.cache.hits)} />
            <Stat label="Misses" value={formatCount(pulse.cache.misses)} />
            <Stat label="Sets" value={formatCount(pulse.cache.sets)} />
            <Stat label="Hit ratio" value={formatPercent(pulse.cache.hitRatio)} />
          </div>
        </Panel>
      )}
    </div>
  );
}

function StatusBars({
  status,
  total,
}: {
  status: PulseSummary['requests']['status'];
  total: number;
}) {
  const rows: { key: keyof typeof status; textClass: string; barColor: string }[] = [
    { key: '2xx', textClass: 'text-good', barColor: 'var(--agora-good)' },
    { key: '3xx', textClass: 'text-live', barColor: 'var(--agora-live)' },
    { key: '4xx', textClass: 'text-warn', barColor: 'var(--agora-warn)' },
    { key: '5xx', textClass: 'text-bad', barColor: 'var(--agora-bad)' },
    { key: 'other', textClass: 'text-muted-foreground', barColor: 'var(--agora-muted)' },
  ];
  const denom = total > 0 ? total : 1;
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(({ key, textClass, barColor }) => (
        <div key={key} className="flex items-center gap-2.5">
          <span className={cn('mono w-11', textClass)}>{key}</span>
          <div className="flex-1">
            <ShareBar fraction={status[key] / denom} color={barColor} />
          </div>
          <span className="mono tnum w-14 text-right text-[11.5px] text-faint">
            {formatCount(status[key])}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Inline `type: count` pairs, one per row, sorted by count descending. */
function EntriesByType({ counts }: { counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <Empty>No entries in this window.</Empty>;
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
      {rows.map(([type, count]) => (
        <li key={type} className="flex items-center gap-1.5">
          <span
            className="type-ink size-[7px] shrink-0 rounded-full bg-current"
            style={typeStyle(type)}
          />
          <span className="text-dim">{typeLabel(type)}</span>
          <span className="mono tnum text-fg">{formatCount(count)}</span>
        </li>
      ))}
    </ul>
  );
}

function HotspotList({
  rows,
  empty,
  onOpenTrace,
}: {
  rows: { key: string; label: string; right: string; traceId?: string | null }[];
  empty: string;
  onOpenTrace?: (traceId: string) => void;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <TableBody>
        {rows.map((row) => {
          const linkable = row.traceId && onOpenTrace;
          return (
            <TableRow
              key={row.key}
              className={cn(linkable && 'cursor-pointer')}
              {...(linkable ? clickable(() => onOpenTrace?.(row.traceId as string)) : {})}
            >
              <TableCell className="mono max-w-[420px] truncate whitespace-nowrap text-[12px] text-fg-2">
                {row.label}
              </TableCell>
              <TableCell className="mono tnum whitespace-nowrap text-right text-[11.5px] text-faint">
                {row.right}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Pulse while its rollup loads: the stat row and two panels, shaped like the page. */
function PulseSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <MetricGridSkeleton count={4} />
      <Panel>
        <Skeleton rows={2} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <Skeleton rows={4} />
        </Panel>
        <Panel>
          <Skeleton rows={4} />
        </Panel>
      </div>
    </div>
  );
}
