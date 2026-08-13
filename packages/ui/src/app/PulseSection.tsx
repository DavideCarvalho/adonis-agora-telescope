import { useState } from 'react';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { PulseSummary } from '../client/types.js';
import { WindowSelect } from './WindowSelect.js';
import { cn } from './primitives/cn.js';
import { Table, TableBody, TableCell, TableRow } from './primitives/table.js';
import {
  AsyncBlock,
  Empty,
  Panel,
  SectionTitle,
  ShareBar,
  Sparkline,
  Stat,
  clickable,
  typeColor,
  typeLabel,
} from './ui.js';
import { usePulse } from './use-telescope.js';

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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-brand">Pulse · health overview</h2>
        <WindowSelect value={windowMs} onChange={setWindowMs} />
      </div>
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={4}>
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
  const errorClass =
    pulse.requests.errorRate >= 0.05
      ? 'text-bad'
      : pulse.requests.errorRate > 0
        ? 'text-warn'
        : 'text-good';
  const throughputSeries = pulse.throughput.overTime.buckets.map((b) => b.total);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-4">
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
      </div>

      <Panel>
        <SectionTitle title="Throughput by type" hint={`${throughputSeries.length} buckets`} />
        <Sparkline values={throughputSeries} width={1180} height={64} />
      </Panel>

      <Panel>
        <SectionTitle title="Entries by type" />
        <EntriesByType counts={pulse.counts} />
      </Panel>

      <div className="grid grid-cols-2 gap-4">
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
          <HotspotList
            rows={pulse.slowOutgoing.map((r) => ({
              key: r.route,
              label: r.route,
              right: `${formatDuration(r.p99)} · ×${r.count}`,
            }))}
            empty="No slow outgoing calls."
          />
        </Panel>
      </div>

      {pulse.cache && (
        <Panel>
          <SectionTitle title="Cache" hint={`hit ratio ${formatPercent(pulse.cache.hitRatio)}`} />
          <div className="grid grid-cols-4 gap-4">
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
    { key: '2xx', textClass: 'text-good', barColor: 'var(--good)' },
    { key: '3xx', textClass: 'text-live', barColor: 'var(--live)' },
    { key: '4xx', textClass: 'text-warn', barColor: 'var(--warn)' },
    { key: '5xx', textClass: 'text-bad', barColor: 'var(--bad)' },
    { key: 'other', textClass: 'text-muted-foreground', barColor: 'var(--muted)' },
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
          <span className="tnum w-14 text-right text-muted-foreground">
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
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: typeColor(type) }}
          />
          <span className="text-muted-foreground">{typeLabel(type)}:</span>
          <span className="tnum text-foreground">{formatCount(count)}</span>
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
              className={cn(linkable && 'cursor-pointer hover:bg-brand/5')}
              {...(linkable ? clickable(() => onOpenTrace?.(row.traceId as string)) : {})}
            >
              <TableCell className="mono max-w-[420px] truncate">{row.label}</TableCell>
              <TableCell className="tnum text-right text-muted-foreground">{row.right}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
