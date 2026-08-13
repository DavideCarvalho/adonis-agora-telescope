import { useState } from 'react';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type {
  PulseSummary,
  QueueSummary,
  RetentionInfo,
  TimeseriesReport,
} from '../client/types.js';
import { WindowSelect } from './WindowSelect.js';
import { cn } from './primitives/cn.js';
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
import { useLiveQueues, usePulse, useRetention, useTimeseries } from './use-telescope.js';

/** A queue backlog at/above this is "needs attention" even with zero failures. */
const QUEUE_WAITING_ATTENTION_THRESHOLD = 100;
/** Above this fraction the error-rate stat turns red. */
const ERROR_RATE_ALERT_THRESHOLD = 0.05;

function queuePending(queue: QueueSummary): number {
  return (queue.counts.pending ?? 0) + (queue.counts.delayed ?? 0);
}

/** Queues that need an operator's eyes: any with failed jobs, or a large pending/delayed backlog. */
export function queuesNeedingAttention(queues: QueueSummary[]): QueueSummary[] {
  return queues.filter(
    (q) => (q.counts.failed ?? 0) > 0 || queuePending(q) >= QUEUE_WAITING_ATTENTION_THRESHOLD,
  );
}

/**
 * The Overview "at a glance" landing page — distinct from Pulse (see `PulseSection.tsx`). Pulse is
 * a deep single-window health rollup; Overview is a wider triage grid: criticality stats up top,
 * then failures/hotspots, then trend + composition, then the console's own retention posture.
 * Matches `@dudousxd/nestjs-telescope-ui`'s `OverviewPage` structurally, trimmed to the data this
 * core actually exposes (no server-process/self-health endpoints exist yet — see the `README`/PR
 * notes for that gap).
 */
export function OverviewSection({
  onOpenTrace,
  onOpenEntry,
  onOpenQueues,
}: {
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
  onOpenQueues: () => void;
}) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const pulseState = usePulse(windowMs);
  const queuesState = useLiveQueues();
  const seriesState = useTimeseries(windowMs, 60);
  const retentionState = useRetention();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-brand">Overview</h2>
        <WindowSelect value={windowMs} onChange={setWindowMs} />
      </div>
      <AsyncBlock state={pulseState} empty="No data in this window." skeletonRows={4}>
        {(pulse) => (
          <OverviewBody
            pulse={pulse}
            queues={queuesState.data?.queues ?? []}
            series={seriesState.data ?? undefined}
            retention={retentionState.data ?? undefined}
            onOpenTrace={onOpenTrace}
            onOpenEntry={onOpenEntry}
            onOpenQueues={onOpenQueues}
          />
        )}
      </AsyncBlock>
    </div>
  );
}

function OverviewBody({
  pulse,
  queues,
  series,
  retention,
  onOpenTrace,
  onOpenEntry,
  onOpenQueues,
}: {
  pulse: PulseSummary;
  queues: QueueSummary[];
  series: TimeseriesReport | undefined;
  retention: RetentionInfo | undefined;
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
  onOpenQueues: () => void;
}) {
  const failedJobs = queues.reduce((acc, q) => acc + (q.counts.failed ?? 0), 0);
  const attentionQueues = queuesNeedingAttention(queues);
  const errorClass =
    pulse.requests.errorRate >= ERROR_RATE_ALERT_THRESHOLD
      ? 'text-bad'
      : pulse.requests.errorRate > 0
        ? 'text-warn'
        : 'text-good';

  return (
    <div className="flex flex-col gap-4">
      {/* TOP — "what's wrong right now": criticality stat row. */}
      <div className="grid grid-cols-4 gap-4">
        <Stat
          label="Requests"
          value={formatCount(pulse.requests.total)}
          sub={`${formatCount(Object.values(pulse.counts).reduce((a, b) => a + b, 0))} entries total`}
        />
        <Stat
          label="Error rate"
          value={<span className={errorClass}>{formatPercent(pulse.requests.errorRate)}</span>}
          sub={`${formatCount(pulse.requests.status['5xx'] + pulse.requests.status['4xx'])} errors`}
        />
        <Stat
          label="Failed jobs"
          value={<span className={failedJobs > 0 ? 'text-bad' : undefined}>{failedJobs}</span>}
          sub="across queues"
        />
        <Stat
          label="Slow routes"
          value={
            <span className={pulse.slowRoutes.length > 0 ? 'text-warn' : undefined}>
              {pulse.slowRoutes.length}
            </span>
          }
          sub="over the slow p99 threshold"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <SectionTitle title="Recent failures" />
          <ListRows
            rows={pulse.topExceptions.map((e) => ({
              key: e.key,
              label: (
                <>
                  <span className="text-bad">{e.class}</span>{' '}
                  <span className="text-muted-foreground">{e.message}</span>
                </>
              ),
              right: `×${formatCount(e.count)}`,
            }))}
            empty="No exceptions 🎉"
          />
        </Panel>
        <Panel>
          <SectionTitle title="N+1 query hotspots" hint="by wasted time" />
          <ListRows
            rows={pulse.nPlusOne.map((n) => ({
              key: n.familyHash,
              label: (
                <>
                  <span className="whitespace-nowrap text-warn">×{n.perRequest}</span>{' '}
                  <span className="truncate text-muted-foreground">{n.sql}</span>
                </>
              ),
              right: `${n.total} total${n.totalDurationMs > 0 ? ` · ${formatDuration(n.totalDurationMs)}` : ''}`,
              onClick: n.sampleTraceId ? () => onOpenTrace(n.sampleTraceId) : undefined,
            }))}
            empty="None detected"
          />
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <SectionTitle title="Slowest" hint="across all types" />
          <ListRows
            rows={pulse.slowest.map((s) => ({
              key: s.id,
              label: (
                <>
                  <span className="text-brand">{s.type}</span>{' '}
                  <span className="text-muted-foreground">{s.label}</span>
                </>
              ),
              right: formatDuration(s.durationMs),
              onClick: () => onOpenEntry(s.id),
            }))}
            empty="Nothing slow in window."
          />
        </Panel>
        <Panel>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Queues needing attention
            </h3>
            <button
              type="button"
              onClick={onOpenQueues}
              className="text-[11px] text-muted-foreground hover:text-brand"
            >
              All queues →
            </button>
          </div>
          {attentionQueues.length > 0 ? (
            <ListRows
              rows={attentionQueues.map((q) => ({
                key: q.queue,
                label: <span className="text-foreground">{q.queue}</span>,
                right: (
                  <>
                    {(q.counts.failed ?? 0) > 0 ? (
                      <span className="text-bad">{q.counts.failed} failed</span>
                    ) : null}
                    {(q.counts.failed ?? 0) > 0 &&
                    queuePending(q) >= QUEUE_WAITING_ATTENTION_THRESHOLD
                      ? ' · '
                      : ''}
                    {queuePending(q) >= QUEUE_WAITING_ATTENTION_THRESHOLD ? (
                      <span className="text-warn">{queuePending(q)} pending</span>
                    ) : null}
                  </>
                ),
                onClick: onOpenQueues,
              }))}
              empty="All queues healthy"
            />
          ) : (
            <p className="text-[13px] text-good">All queues healthy</p>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <SectionTitle title="Slowest jobs" />
          <ListRows
            rows={pulse.slowJobs.map((j) => ({
              key: j.route,
              label: <span className="text-foreground">{j.route}</span>,
              right: `${formatDuration(j.p99)} p99 · ×${j.count}`,
            }))}
            empty="No jobs in window."
          />
        </Panel>
        <Panel>
          <SectionTitle title="Load by user" />
          <ListRows
            rows={pulse.loadByUser.map((u) => ({
              key: u.user,
              label: <span className="text-foreground">{u.user}</span>,
              right: `${formatCount(u.count)} · ${formatDuration(u.totalDurationMs)}`,
            }))}
            empty="No identified users in window."
          />
        </Panel>
      </div>

      {/* BOTTOM — trends & composition, plus this console's own retention posture. */}
      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <SectionTitle title="Throughput" hint={`${series?.buckets.length ?? 0} buckets`} />
          <Sparkline values={(series?.buckets ?? []).map((b) => b.total)} width={560} height={64} />
        </Panel>
        <Panel>
          <SectionTitle title="By type" />
          <ByTypeBreakdown series={series} />
        </Panel>
      </div>

      <Panel>
        <SectionTitle title="Retention" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Window"
            value={retention?.enabled ? formatRetentionWindow(retention.afterMs) : 'none'}
            sub={retention?.keepLast != null ? `keep last ${retention.keepLast}` : undefined}
          />
          <Stat
            label="Prune interval"
            value={retention ? formatRetentionWindow(retention.intervalMs) : '—'}
          />
          <Stat
            label="Sampled types"
            value={retention?.sampling.length ?? 0}
            sub={
              retention && retention.sampling.length > 0
                ? `${retention.sampling[0]?.type} @ ${Math.round((retention.sampling[0]?.rate ?? 0) * 100)}%`
                : 'all at 100%'
            }
          />
        </div>
      </Panel>
    </div>
  );
}

function formatRetentionWindow(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A compact ShareBar-per-type breakdown — the dependency-free stand-in for a stacked area chart. */
function ByTypeBreakdown({ series }: { series: TimeseriesReport | undefined }) {
  const totals = new Map<string, number>();
  for (const bucket of series?.buckets ?? []) {
    for (const [type, count] of Object.entries(bucket.byType)) {
      totals.set(type, (totals.get(type) ?? 0) + count);
    }
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((acc, [, count]) => acc + count, 0) || 1;
  if (rows.length === 0) return <Empty>No data in this window.</Empty>;
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(([type, count]) => (
        <div key={type} className="flex items-center gap-2.5">
          <span className="w-24 shrink-0 truncate text-xs" style={{ color: typeColor(type) }}>
            {typeLabel(type)}
          </span>
          <div className="flex-1">
            <ShareBar fraction={count / total} color={typeColor(type)} />
          </div>
          <span className="tnum w-14 text-right text-xs text-muted-foreground">
            {formatCount(count)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ListRows({
  rows,
  empty,
}: {
  rows: {
    key: string;
    label: React.ReactNode;
    right: React.ReactNode;
    onClick?: (() => void) | undefined;
  }[];
  empty: string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((row) => (
        <li
          key={row.key}
          {...(row.onClick ? clickable(row.onClick) : {})}
          className={cn(
            'flex items-center justify-between gap-3 border-t border-line-soft pt-1 first:border-0 first:pt-0',
            row.onClick && 'cursor-pointer hover:text-foreground',
          )}
        >
          <span className="min-w-0 truncate">{row.label}</span>
          <span className="tnum shrink-0 text-muted-foreground">{row.right}</span>
        </li>
      ))}
    </ul>
  );
}
