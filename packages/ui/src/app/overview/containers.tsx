import { formatCount, formatDuration, formatPercent } from '../../client/format.js';
import type { QueueSummary, TimeseriesReport } from '../../client/types.js';
import { cn } from '../primitives/cn.js';
import {
  AsyncBlock,
  clickable,
  Empty,
  Panel,
  SectionTitle,
  ShareBar,
  Sparkline,
  Stat,
  typeColor,
  typeLabel,
  WatcherOff,
} from '../ui.js';
import {
  useLiveQueues,
  usePulse,
  useRetention,
  useTimeseries,
  useWatcherEnabled,
} from '../use-telescope.js';

/**
 * The Overview's containers: each one fetches what it needs and owns its own loading
 * and error state.
 *
 * The page used to hoist all four reads to the top and gate the whole grid on ONE
 * `AsyncBlock` over `pulse` — the slowest of them. Queue counts and the throughput
 * chart could be sitting in memory and you would still be staring at a skeleton
 * because an aggregation query had not finished. Worse for the reader: a page-wide
 * spinner cannot say WHICH part is slow, so "the console is slow" was the only
 * available diagnosis.
 *
 * Several containers here read `pulse`. That is one request, not six: TanStack Query
 * dedupes by key, which is what makes splitting a page into self-fetching containers
 * a parallelization instead of a multiplication.
 */

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
 * A compact label/value list. Lives here (rather than in `ui.tsx`) because every user
 * of it is an Overview panel — moving it to the shared module would widen the shared
 * surface for one consumer.
 */
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

/** A stat tile that shows a dash until its own data lands, instead of blocking the row. */
function PendingStat({ label, sub }: { label: string; sub?: string }) {
  return <Stat label={label} value={<span className="text-muted-foreground">—</span>} sub={sub} />;
}

export function RequestsStat({
  windowMs,
  onOpenType,
}: {
  windowMs: number;
  onOpenType: (type: string) => void;
}) {
  const { data } = usePulse(windowMs);
  if (data === null) return <PendingStat label="Requests" />;
  return (
    <Stat
      label="Requests"
      value={formatCount(data.requests.total)}
      sub={`${formatCount(Object.values(data.counts).reduce((a, b) => a + b, 0))} entries total`}
      onClick={() => onOpenType('request')}
    />
  );
}

export function ErrorRateStat({
  windowMs,
  onOpenExceptions,
}: {
  windowMs: number;
  onOpenExceptions: () => void;
}) {
  const { data } = usePulse(windowMs);
  if (data === null) return <PendingStat label="Error rate" />;
  const rate = data.requests.errorRate;
  const errorClass =
    rate >= ERROR_RATE_ALERT_THRESHOLD ? 'text-bad' : rate > 0 ? 'text-warn' : 'text-good';
  return (
    <Stat
      label="Error rate"
      value={<span className={errorClass}>{formatPercent(rate)}</span>}
      sub={`${formatCount(data.requests.status['5xx'] + data.requests.status['4xx'])} errors`}
      onClick={onOpenExceptions}
    />
  );
}

export function FailedJobsStat({ onOpenQueues }: { onOpenQueues: () => void }) {
  const { data } = useLiveQueues();
  if (data === null) return <PendingStat label="Failed jobs" sub="across queues" />;
  const failed = data.queues.reduce((acc, q) => acc + (q.counts.failed ?? 0), 0);
  return (
    <Stat
      label="Failed jobs"
      value={<span className={failed > 0 ? 'text-bad' : undefined}>{failed}</span>}
      sub="across queues"
      onClick={onOpenQueues}
    />
  );
}

export function SlowRoutesStat({
  windowMs,
  onOpenPulse,
}: {
  windowMs: number;
  onOpenPulse: () => void;
}) {
  const { data } = usePulse(windowMs);
  if (data === null) return <PendingStat label="Slow routes" sub="over the slow p99 threshold" />;
  return (
    <Stat
      label="Slow routes"
      value={
        <span className={data.slowRoutes.length > 0 ? 'text-warn' : undefined}>
          {data.slowRoutes.length}
        </span>
      }
      sub="over the slow p99 threshold"
      onClick={onOpenPulse}
    />
  );
}

export function RecentFailuresPanel({ windowMs }: { windowMs: number }) {
  const state = usePulse(windowMs);
  return (
    <Panel>
      <SectionTitle title="Recent failures" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={4}>
        {(pulse) => (
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
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function NPlusOnePanel({
  windowMs,
  onOpenTrace,
}: {
  windowMs: number;
  onOpenTrace: (traceId: string) => void;
}) {
  const state = usePulse(windowMs);
  // N+1 é derivado de entries `query`. Sem esse watcher o painel não pode detectar
  // nada — e dizer "nenhum detectado" seria afirmar saúde a partir de cegueira.
  const queryWatcher = useWatcherEnabled('query');
  if (queryWatcher === false) {
    return (
      <Panel>
        <SectionTitle title="N+1 query hotspots" hint="by wasted time" />
        <WatcherOff watcher="query" config="config/telescope_watchers.ts" />
      </Panel>
    );
  }
  return (
    <Panel>
      <SectionTitle title="N+1 query hotspots" hint="by wasted time" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={4}>
        {(pulse) => (
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
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function SlowestPanel({
  windowMs,
  onOpenEntry,
}: {
  windowMs: number;
  onOpenEntry: (id: string) => void;
}) {
  const state = usePulse(windowMs);
  return (
    <Panel>
      <SectionTitle title="Slowest" hint="across all types" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={4}>
        {(pulse) => (
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
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function QueuesAttentionPanel({ onOpenQueues }: { onOpenQueues: () => void }) {
  const state = useLiveQueues();
  return (
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
      <AsyncBlock state={state} empty="No queues configured." skeletonRows={3}>
        {(live) => {
          const attention = queuesNeedingAttention(live.queues);
          if (attention.length === 0) {
            return <p className="text-[13px] text-good">All queues healthy</p>;
          }
          return (
            <ListRows
              rows={attention.map((q) => ({
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
          );
        }}
      </AsyncBlock>
    </Panel>
  );
}

export function SlowestJobsPanel({ windowMs }: { windowMs: number }) {
  const state = usePulse(windowMs);
  const queueWatcher = useWatcherEnabled('queue');
  if (queueWatcher === false) {
    return (
      <Panel>
        <SectionTitle title="Slowest jobs" />
        <WatcherOff watcher="queue" config="config/telescope_watchers.ts" />
      </Panel>
    );
  }
  return (
    <Panel>
      <SectionTitle title="Slowest jobs" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={3}>
        {(pulse) => (
          <ListRows
            rows={pulse.slowJobs.map((j) => ({
              key: j.route,
              label: <span className="text-foreground">{j.route}</span>,
              right: `${formatDuration(j.p99)} p99 · ×${j.count}`,
            }))}
            empty="No jobs in window."
          />
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function LoadByUserPanel({ windowMs }: { windowMs: number }) {
  const state = usePulse(windowMs);
  return (
    <Panel>
      <SectionTitle title="Load by user" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={3}>
        {(pulse) => (
          <ListRows
            rows={pulse.loadByUser.map((u) => ({
              key: u.user,
              label: <span className="text-foreground">{u.user}</span>,
              right: `${formatCount(u.count)} · ${formatDuration(u.totalDurationMs)}`,
            }))}
            empty="No identified users in window."
          />
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function ThroughputPanel({ windowMs }: { windowMs: number }) {
  const state = useTimeseries(windowMs, 60);
  return (
    <Panel>
      <SectionTitle title="Throughput" hint={`${state.data?.buckets.length ?? 0} buckets`} />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={2}>
        {(series) => (
          <Sparkline values={series.buckets.map((b) => b.total)} width={560} height={64} />
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function ByTypePanel({ windowMs }: { windowMs: number }) {
  const state = useTimeseries(windowMs, 60);
  return (
    <Panel>
      <SectionTitle title="By type" />
      <AsyncBlock state={state} empty="No data in this window." skeletonRows={4}>
        {(series) => <ByTypeBreakdown series={series} />}
      </AsyncBlock>
    </Panel>
  );
}

/** A compact ShareBar-per-type breakdown — the dependency-free stand-in for a stacked area chart. */
function ByTypeBreakdown({ series }: { series: TimeseriesReport }) {
  const totals = new Map<string, number>();
  for (const bucket of series.buckets) {
    for (const [type, count] of Object.entries(bucket.byType)) {
      totals.set(type, (totals.get(type) ?? 0) + count);
    }
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((acc, [, count]) => acc + count, 0);
  if (total === 0) return <Empty>No entries in window.</Empty>;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([type, count]) => (
        <div key={type} className={cn('flex items-center gap-2.5 text-[13px]')}>
          <span className="w-28 shrink-0 truncate text-muted-foreground">{typeLabel(type)}</span>
          <ShareBar fraction={count / total} color={typeColor(type)} />
          <span className="tnum w-16 shrink-0 text-right text-muted-foreground">
            {formatCount(count)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RetentionPanel() {
  const state = useRetention();
  return (
    <Panel>
      <SectionTitle title="Retention" />
      <AsyncBlock state={state} empty="Retention not reported." skeletonRows={1}>
        {(retention) => (
          <div className="grid grid-cols-3 gap-4">
            <Stat
              label="Window"
              value={retention.enabled ? formatRetentionWindow(retention.afterMs) : 'none'}
              sub={retention.keepLast != null ? `keep last ${retention.keepLast}` : undefined}
            />
            <Stat label="Prune interval" value={formatRetentionWindow(retention.intervalMs)} />
            <Stat
              label="Sampled types"
              value={retention.sampling.length}
              sub={
                retention.sampling.length > 0
                  ? `${retention.sampling[0]?.type} @ ${Math.round((retention.sampling[0]?.rate ?? 0) * 100)}%`
                  : 'all at 100%'
              }
            />
          </div>
        )}
      </AsyncBlock>
    </Panel>
  );
}

export function formatRetentionWindow(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
