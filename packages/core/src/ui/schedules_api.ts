import type { TelescopeService } from '../service.js';
import type { ScheduleEntryContent, ScheduleRunStatus } from '../watchers/schedule_watcher.js';
import { listRegisteredSchedules, type RegisteredSchedule } from '../watchers/schedule_watcher.js';
import type { UiHttpContext } from './http.js';

/**
 * One row of the Live Schedules view: a {@link RegisteredSchedule} (name/kind/expression/`nextRunAt`
 * — what `registerSchedule()` told us EXISTS) joined against its most recent `scheduled_task` entry
 * (what the schedule watcher recorded ACTUALLY ran). Mirrors the shape of `nestjs-telescope`'s
 * `ScheduledTask` closely enough for the two dashboards' schedule views to share a component shape,
 * MINUS `running`: AdonisJS has no object to read a running/stopped flag off (see
 * `schedule_watcher.ts`'s module doc), so that field is simply omitted rather than faked as `null`
 * everywhere (which the NestJS type uses for "unknowable" — here it would be "always unknowable",
 * which isn't worth a column).
 */
export interface LiveScheduledTask {
  name: string;
  kind: RegisteredSchedule['kind'];
  schedule: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: ScheduleRunStatus | null;
}

/**
 * `GET <path>/api/schedules/live` handler over the registry `registerSchedule()` maintains (see
 * `schedule_watcher.ts`'s module doc for the full design rationale — there is no scanning mechanism
 * to build this from, so it is populated by explicit registration). Kept in its own class mirroring
 * {@link ProfilesApi}/{@link QueueManagerApi} for the same reason: it reads a registry the provider
 * doesn't hand to {@link TelescopeApi}'s constructor.
 *
 * Unlike those two, there is no "not configured" 404 here: {@link listRegisteredSchedules} already
 * degrades to `[]` when the schedule watcher isn't started, and an EMPTY schedules list is a normal,
 * renderable state (not an error) — mirroring `nestjs-telescope`'s `schedules/live` route, which
 * likewise just returns `{ tasks: [] }` when nothing is registered yet.
 */
export class SchedulesApi {
  constructor(private readonly service: TelescopeService) {}

  /** `GET <path>/api/schedules/live` — every registered schedule, joined with its last run. */
  async live(ctx: UiHttpContext): Promise<unknown> {
    const registered = listRegisteredSchedules();
    const tasks = await Promise.all(registered.map((reg) => this.withLastRun(reg)));
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: { tasks } });
  }

  private async withLastRun(reg: RegisteredSchedule): Promise<LiveScheduledTask> {
    // Newest-first + familyHash exact match + limit 1 ⇒ the single most recent run of this task.
    const [last] = await this.service.list({ familyHash: `schedule:${reg.name}`, limit: 1 });
    const content = last?.content as ScheduleEntryContent | undefined;
    return {
      name: reg.name,
      kind: reg.kind,
      schedule: reg.schedule,
      nextRunAt: reg.nextRunAt,
      lastRunAt: last ? toIso(last.createdAt) : null,
      lastDurationMs: content?.durationMs ?? last?.durationMs ?? null,
      lastStatus: content?.status ?? null,
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
