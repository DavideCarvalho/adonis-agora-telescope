import { useState } from 'react';
import {
  ByTypePanel,
  ErrorRateStat,
  FailedJobsStat,
  LoadByUserPanel,
  NPlusOnePanel,
  QueuesAttentionPanel,
  RecentFailuresPanel,
  RequestsStat,
  RetentionPanel,
  SlowestJobsPanel,
  SlowestPanel,
  SlowRoutesStat,
  ThroughputPanel,
} from './overview/containers.js';
import { WindowSelect } from './WindowSelect.js';

export { queuesNeedingAttention } from './overview/containers.js';

/**
 * The Overview "at a glance" landing page — distinct from Pulse (see `PulseSection.tsx`). Pulse is
 * a deep single-window health rollup; Overview is a wider triage grid: criticality stats up top,
 * then failures/hotspots, then trend + composition, then the console's own retention posture.
 *
 * This file is LAYOUT ONLY. It owns the window selector and the grid; every panel below fetches
 * its own data and renders its own loading and error state (see `overview/containers.tsx`).
 *
 * It used to hoist all four reads to the top and gate the entire grid on one `AsyncBlock` over
 * `pulse`, the slowest of them: queue counts and the throughput chart could be in memory and you
 * would still see a skeleton because an aggregation query had not finished. A page-wide spinner
 * also cannot say which part is slow, so "the console is slow" was the only diagnosis available —
 * in a console whose whole job is making that question answerable.
 */
export function OverviewSection({
  onOpenTrace,
  onOpenEntry,
  onOpenQueues,
  onOpenPulse,
  onOpenExceptions,
  onOpenType,
}: {
  onOpenTrace: (traceId: string) => void;
  onOpenEntry: (id: string) => void;
  onOpenQueues: () => void;
  onOpenPulse: () => void;
  onOpenExceptions: () => void;
  onOpenType: (type: string) => void;
}) {
  const [windowMs, setWindowMs] = useState(3_600_000);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-brand">Overview</h2>
        <WindowSelect value={windowMs} onChange={setWindowMs} />
      </div>

      {/* TOP — "what's wrong right now": criticality stat row. */}
      <div className="grid grid-cols-4 gap-4">
        <RequestsStat windowMs={windowMs} onOpenType={onOpenType} />
        <ErrorRateStat windowMs={windowMs} onOpenExceptions={onOpenExceptions} />
        <FailedJobsStat onOpenQueues={onOpenQueues} />
        <SlowRoutesStat windowMs={windowMs} onOpenPulse={onOpenPulse} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <RecentFailuresPanel windowMs={windowMs} />
        <NPlusOnePanel windowMs={windowMs} onOpenTrace={onOpenTrace} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SlowestPanel windowMs={windowMs} onOpenEntry={onOpenEntry} />
        <QueuesAttentionPanel onOpenQueues={onOpenQueues} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SlowestJobsPanel windowMs={windowMs} />
        <LoadByUserPanel windowMs={windowMs} />
      </div>

      {/* BOTTOM — trends & composition, plus this console's own retention posture. */}
      <div className="grid grid-cols-2 gap-4">
        <ThroughputPanel windowMs={windowMs} />
        <ByTypePanel windowMs={windowMs} />
      </div>

      <RetentionPanel />
    </div>
  );
}
