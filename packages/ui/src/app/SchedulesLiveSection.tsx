import { Badge } from '../agora-kit/ui/badge';
import { formatDuration, formatRelative } from '../client/format.js';
import type { LiveScheduledTask, ScheduleKind, ScheduleRunStatus } from '../client/types.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { AsyncBlock, PageHeader, Panel, SectionTitle } from './ui.js';
import { useLiveSchedules } from './use-telescope.js';

const KIND_VARIANT: Record<ScheduleKind, 'brand' | 'neutral' | 'warn'> = {
  cron: 'brand',
  interval: 'neutral',
  custom: 'warn',
};

function KindBadge({ kind }: { kind: ScheduleKind }) {
  return <Badge variant={KIND_VARIANT[kind]}>{kind}</Badge>;
}

function StatusBadge({ status }: { status: ScheduleRunStatus | null }) {
  if (status === null) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={status === 'completed' ? 'good' : 'destructive'}>{status}</Badge>;
}

/** Next-run is an ISO string in the future; `formatRelative` only reads sensibly for the past, so
 *  the absolute local time is shown for the next fire instead. */
function formatNextRun(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function ScheduleRow({ task }: { task: LiveScheduledTask }) {
  return (
    <TableRow>
      <TableCell className="font-medium text-fg">{task.name}</TableCell>
      <TableCell>
        <KindBadge kind={task.kind} />
      </TableCell>
      <TableCell className="mono text-xs text-muted-foreground">{task.pool ?? '—'}</TableCell>
      <TableCell className="mono text-xs text-muted-foreground">{task.schedule ?? '—'}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatNextRun(task.nextRunAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {task.lastRunAt ? formatRelative(task.lastRunAt) : '—'}
      </TableCell>
      <TableCell className="tnum text-xs text-muted-foreground">
        {formatDuration(task.lastDurationMs)}
      </TableCell>
      <TableCell>
        <StatusBadge status={task.lastStatus} />
      </TableCell>
    </TableRow>
  );
}

/**
 * Live Schedules: every schedule registered via `registerSchedule()` (see the core package's
 * `src/watchers/schedule_watcher.ts` for the full design rationale — AdonisJS has no first-party
 * cron scanning, so this is populated by explicit registration, not discovery), each row joined
 * with its most recent recorded `scheduled_task` run. Deliberately has NO "active/running" column
 * (unlike the NestJS sibling's `ScheduledTask.running`): AdonisJS has no object to read a
 * running/stopped flag off, so faking one would be worse than omitting it.
 */
export function SchedulesLiveSection() {
  const { data, loading, error, reload } = useLiveSchedules();
  const tasks = data?.tasks ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Schedules"
        description="Every registered schedule with its next fire and its most recent recorded run."
      />
      <Panel>
        <SectionTitle
          title="Live schedules"
          hint={tasks.length > 0 ? `${tasks.length} registered` : undefined}
        />
        <AsyncBlock
          state={{ data: data ? tasks : null, loading, error, reload }}
          isEmpty={(rows) => rows.length === 0}
          empty="No schedules registered. Call registerSchedule({ name, schedule, kind }) once per scheduled task to populate this console."
        >
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Pool</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((task) => (
                  <ScheduleRow key={`${task.kind}:${task.name}`} task={task} />
                ))}
              </TableBody>
            </Table>
          )}
        </AsyncBlock>
      </Panel>
    </div>
  );
}
