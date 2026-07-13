import { useState } from 'react';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { PulseSummary } from '../client/types.js';
import { WindowSelect } from './WindowSelect.js';
import { AsyncBlock, Panel, SectionTitle, Sparkline, Stat, clickable } from './ui.js';
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
    <div className="stack">
      <div className="section-title">
        <h2>Pulse · health overview</h2>
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
    pulse.requests.errorRate >= 0.05 ? 'bad' : pulse.requests.errorRate > 0 ? 'warn' : 'good';
  const throughputSeries = pulse.throughput.overTime.buckets.map((b) => b.total);

  return (
    <div className="stack">
      <div className="grid stat-4">
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
        <SectionTitle title="Throughput" hint={`${throughputSeries.length} buckets`} />
        <Sparkline values={throughputSeries} width={1180} height={64} />
      </Panel>

      <div className="grid cols-2">
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
      </div>

      {pulse.cache && (
        <Panel>
          <SectionTitle title="Cache" hint={`hit ratio ${formatPercent(pulse.cache.hitRatio)}`} />
          <div className="grid stat-4">
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
  const rows: { key: keyof typeof status; color: string }[] = [
    { key: '2xx', color: 'var(--good)' },
    { key: '3xx', color: 'var(--info)' },
    { key: '4xx', color: 'var(--warn)' },
    { key: '5xx', color: 'var(--bad)' },
    { key: 'other', color: 'var(--muted)' },
  ];
  const denom = total > 0 ? total : 1;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map(({ key, color }) => (
        <div key={key} className="controls" style={{ gap: 10 }}>
          <span className="mono" style={{ width: 44, color }}>
            {key}
          </span>
          <div className="bar" style={{ flex: 1 }}>
            <span style={{ width: `${(status[key] / denom) * 100}%`, background: color }} />
          </div>
          <span className="tnum muted" style={{ width: 56, textAlign: 'right' }}>
            {formatCount(status[key])}
          </span>
        </div>
      ))}
    </div>
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
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {rows.map((row) => {
            const linkable = row.traceId && onOpenTrace;
            return (
              <tr
                key={row.key}
                className={linkable ? 'row-link' : undefined}
                {...(linkable ? clickable(() => onOpenTrace?.(row.traceId as string)) : {})}
              >
                <td
                  className="mono"
                  style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {row.label}
                </td>
                <td className="num tnum muted">{row.right}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
