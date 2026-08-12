import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { nextCronRunMs } from './cron_next_run.js';
import { safeRecord } from './record.js';

/** The `type` of the entries this watcher records. */
export const SCHEDULED_TASK_ENTRY_TYPE = EntryType.ScheduledTask;

/** The terminal outcome of a single scheduled-task run. */
export type ScheduleRunStatus = 'completed' | 'failed';

/** What kind of schedule triggered the run (best-effort, informational). */
export type ScheduleKind = 'cron' | 'interval' | 'custom';

/** The recorded body of a `scheduled_task` entry. */
export interface ScheduleEntryContent {
  /** The task name, e.g. `'prune-sessions'`. */
  name: string;
  /** The cron/interval expression, or `null` when the caller did not supply one. */
  schedule: string | null;
  /** The schedule kind. */
  kind: ScheduleKind;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** The run outcome. */
  status: ScheduleRunStatus;
  /** How many attempts the run represents, or `null`. */
  attempts: number | null;
  /** The failure message when `status` is `'failed'`, else `null`. */
  failureReason: string | null;
  /** The active trace id at run time, or `null`. */
  traceId: string | null;
}

/** A single scheduled-task run — the input to {@link buildScheduleEntry} and
 *  {@link recordScheduledRun}. */
export interface ScheduledRun {
  /** The task name. */
  name: string;
  /** The run outcome. */
  status: ScheduleRunStatus;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** The cron/interval expression, when known. */
  schedule?: string | null;
  /** The schedule kind. Default `'cron'`. */
  kind?: ScheduleKind;
  /** How many attempts the run represents, when known. */
  attempts?: number | null;
  /** The error on a failed run (its message is stored). */
  error?: unknown;
}

/** Options for {@link ScheduleWatcher} and {@link ScheduleWatcher.scheduleTask}. */
export interface ScheduleWatcherOptions {
  /** Runs at/above this many ms get a `slow` tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default `Date.now`. */
  clock?: { now(): number };
}

/** Per-task metadata for the {@link ScheduleWatcher.scheduleTask} wrapper. */
export interface ScheduledTaskOptions {
  /** The cron/interval expression, recorded on each run. */
  schedule?: string | null;
  /** The schedule kind. Default `'cron'`. */
  kind?: ScheduleKind;
}

/**
 * A registration describing "this scheduled task EXISTS" — independent of any individual run. See
 * {@link ScheduleWatcher.register} for why this is a separate call from {@link ScheduledRun}.
 */
export interface ScheduleRegistration {
  /** The task name. Re-registering the same name REPLACES the prior registration (idempotent). */
  name: string;
  /** The cron/interval expression (e.g. `'0 * * * *'`), when the schedule has one. */
  schedule?: string | null;
  /** The schedule kind. Default `'cron'`. */
  kind?: ScheduleKind;
  /**
   * IANA timezone the cron expression is evaluated in (e.g. `'America/Sao_Paulo'`). Only meaningful
   * for `kind: 'cron'`; passed straight through to `cron-parser`. Defaults to the server's local TZ.
   */
  timezone?: string | null;
}

/**
 * A registered schedule enriched with its computed next-run time — what
 * {@link ScheduleWatcher.list} / {@link listRegisteredSchedules} return. Deliberately does NOT
 * include last-run data (status/duration/lastRunAt): that lives in the recorded `scheduled_task`
 * entries this same watcher writes, and joining the two is the UI API layer's job (it already holds
 * a `TelescopeService` to query them) — the registry itself only knows what was registered.
 */
export interface RegisteredSchedule {
  name: string;
  kind: ScheduleKind;
  schedule: string | null;
  timezone: string | null;
  /**
   * ISO timestamp of the next fire, computed from `schedule` via `cron-parser` (see
   * `cron_next_run.ts`). `null` when: the kind isn't `'cron'`, no `schedule` was given, the OPTIONAL
   * `cron-parser` peer isn't installed, or the expression failed to parse — every case is a genuine
   * "unknown", not an error.
   */
  nextRunAt: string | null;
}

/** Default slow-run threshold in milliseconds. */
const DEFAULT_SLOW_MS = 1000;

/**
 * Cross-copy-stable slot holding the provider-configured default watcher, so the
 * standalone {@link recordScheduledRun} / {@link scheduleTask} helpers inherit the
 * app's configured `slowMs` — and are a NO-OP until the provider starts the watcher
 * (schedule capture stays strictly opt-in). Mirrors the http-client / profiling
 * watchers' default-slot stance.
 */
const DEFAULT_SLOT = Symbol.for('@agora/telescope:defaultScheduleWatcher');
const slotHost = globalThis as typeof globalThis & { [DEFAULT_SLOT]?: ScheduleWatcher | null };

function setDefaultScheduleWatcher(watcher: ScheduleWatcher | null): void {
  slotHost[DEFAULT_SLOT] = watcher;
}
function getDefaultScheduleWatcher(): ScheduleWatcher | null {
  return slotHost[DEFAULT_SLOT] ?? null;
}

/**
 * Records each scheduled-task run as a `scheduled_task` telescope entry — capturing
 * the task name, cron/interval expression, duration and outcome
 * (completed/failed), correlated to the active trace.
 *
 * ## Integration point — a wrapper, by design (not a fake event)
 * The NestJS original wraps `@nestjs/schedule`'s `@Cron`/`@Interval`/`@Timeout`
 * decorators via its `SchedulerRegistry`. AdonisJS ships NO first-party scheduler,
 * and the community schedulers (`adonisjs-scheduler` et al.) emit nothing on the
 * app emitter and expose no lifecycle hook — so there is no stable event to tap.
 * Rather than fabricate one, this watcher's integration point is EXPLICIT and
 * idiomatic:
 *
 *  - wrap a scheduled closure with {@link scheduleTask} (it times the run and
 *    records completed/failed, always re-throwing), or
 *  - call {@link recordScheduledRun} yourself from an existing scheduler callback
 *    (e.g. an ace `scheduler:run` command, or a scheduler that DOES surface a
 *    run hook) with the outcome you already have.
 *
 * (In the Agora ecosystem, `@adonis-agora/durable` also bridges its scheduled/cron
 * runs onto the diagnostics bus, which the diagnostics watcher records — this
 * watcher covers plain application-level scheduled work.)
 *
 * Each entry carries `familyHash` (`schedule:<name>`) and `durationMs`, so repeated
 * runs of the same task roll up and feed the slow-hotspot metrics cards. Recording
 * is fire-and-forget and fully guarded: a telescope failure can never break (or
 * delay) a scheduled task.
 *
 * ## The "Live Schedules" registry — the same explicit-integration philosophy, one layer up
 * `recordScheduledRun`/`scheduleTask` answer "what already ran?"; they say nothing about "what
 * schedules EXIST and when will they next fire?" — because, per the section above, AdonisJS gives us
 * no registry of that to read (no `@Cron()` scanning, no `SchedulerRegistry`). {@link register} /
 * {@link registerSchedule} closes that gap the same way: an EXPLICIT, idempotent call the host makes
 * once per scheduled task (typically right next to where it wires the task into whatever scheduler
 * it uses — `adonisjs-scheduler`, `@adonis-agora/durable`'s `@Scheduled`, a hand-rolled interval,
 * …), analogous to how `nestjs-telescope`'s schedule package reads `@nestjs/schedule`'s
 * `SchedulerRegistry` — except here nothing can be read, only told.
 *
 * `nextRunAt` is computed from the registered cron expression via the OPTIONAL `cron-parser` peer
 * (see `cron_next_run.ts`); it is `null` for non-cron kinds or when the peer is absent — an honest
 * "unknown" rather than a guess. There is deliberately no `running`/active-state field (unlike the
 * NestJS `ScheduledTask.running`, which reads a real `CronJob.running` flag off `@nestjs/schedule`'s
 * internals): AdonisJS has no equivalent object to read a running/stopped flag off, so faking one
 * would be strictly worse than omitting it.
 *
 * Idiomatic Adonis: a plain class, no DI decorators. The provider constructs it
 * from `config/telescope_watchers.ts` and calls {@link start} to publish it as the
 * default backing the bare {@link scheduleTask} / {@link recordScheduledRun}
 * helpers; {@link stop} unpublishes.
 */
export class ScheduleWatcher {
  readonly type = EntryType.ScheduledTask;
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  private readonly registrations = new Map<string, ScheduleRegistration>();

  constructor(options: ScheduleWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  /** Publish this configured instance as the default the standalone helpers
   *  inherit. Does NOT patch any global. Named `start`/`stop` to match the other
   *  watchers' provider lifecycle. */
  start(): void {
    setDefaultScheduleWatcher(this);
  }

  /** Unpublish this instance as the default (if it is). Never touches globals. Registrations are
   *  kept (a `stop`/`start` cycle — e.g. hot reload — shouldn't lose them), so a fresh `start()`
   *  sees the same registry; call {@link unregister} explicitly to drop one. */
  stop(): void {
    if (getDefaultScheduleWatcher() === this) setDefaultScheduleWatcher(null);
  }

  /**
   * Register (or re-register — idempotent by `name`) a schedule so it shows up in
   * {@link list} with a computed `nextRunAt`, joined against its `scheduled_task` run history by the
   * UI layer. Call this once per scheduled task, e.g. right after wiring it into your scheduler:
   *
   * @example
   *   import { registerSchedule, scheduleTask } from '@adonis-agora/telescope/watchers'
   *   registerSchedule({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' })
   *   scheduler.call(() => scheduleTask('prune-sessions', () => Session.pruneExpired(), {
   *     schedule: '0 * * * *',
   *   })).hourly()
   */
  register(registration: ScheduleRegistration): void {
    this.registrations.set(registration.name, registration);
  }

  /** Drop a registration (the task was removed / the app is shutting it down). No-op if unknown. */
  unregister(name: string): void {
    this.registrations.delete(name);
  }

  /** Every registered schedule, with `nextRunAt` computed from `now`. Order is registration order. */
  list(): RegisteredSchedule[] {
    const now = this.clock.now();
    return [...this.registrations.values()].map((reg) => toRegisteredSchedule(reg, now));
  }

  /** Record one already-completed scheduled run. Fire-and-forget; never throws. */
  record(run: ScheduledRun): void {
    safeRecord(buildScheduleEntry(run, this.slowMs), 'ScheduleWatcher');
  }

  /**
   * Time `fn` as a scheduled run named `name`. Records `completed` on
   * return/resolve and `failed` on throw/reject, always re-throwing so the
   * scheduler's own error handling is unaffected. Works with sync and async `fn`.
   *
   * @example
   *   scheduler.call(() => scheduleTask('prune-sessions', () => Session.pruneExpired(), {
   *     schedule: '0 * * * *',
   *   })).hourly()
   */
  scheduleTask<T>(name: string, fn: () => T, options: ScheduledTaskOptions = {}): T {
    const startedAt = this.clock.now();
    const finish = (status: ScheduleRunStatus, error: unknown): void => {
      this.record({
        name,
        status,
        durationMs: Math.max(0, this.clock.now() - startedAt),
        schedule: options.schedule ?? null,
        kind: options.kind ?? 'cron',
        error,
      });
    };

    let result: T;
    try {
      result = fn();
    } catch (error) {
      finish('failed', error);
      throw error;
    }
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          finish('completed', undefined);
          return value;
        },
        (error: unknown) => {
          finish('failed', error);
          throw error;
        },
      ) as T;
    }
    finish('completed', undefined);
    return result;
  }
}

/** Narrow a value to a thenable so async `fn`s are awaited without importing a Promise type. */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Map a scheduled run to a telescope {@link RecordInput}. Exported so the entry
 *  shape can be unit-tested without a live watcher. */
export function buildScheduleEntry(
  run: ScheduledRun,
  slowMs = DEFAULT_SLOW_MS,
): RecordInput<ScheduleEntryContent> {
  const durationMs = Math.max(0, run.durationMs);
  const failed = run.status === 'failed';
  const failureReason = failed && run.error !== undefined ? errorMessage(run.error) : null;
  const kind: ScheduleKind = run.kind ?? 'cron';
  const schedule = typeof run.schedule === 'string' ? run.schedule : null;
  const attempts = typeof run.attempts === 'number' ? run.attempts : null;
  const traceId = currentTraceId();

  const content: ScheduleEntryContent = {
    name: run.name,
    schedule,
    kind,
    durationMs,
    status: run.status,
    attempts,
    failureReason,
    traceId,
  };

  const tags: string[] = [
    'schedule',
    `schedule:${kind}`,
    `task:${run.name}`,
    `status:${run.status}`,
  ];
  if (failed) tags.push('failed');
  if (durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.ScheduledTask,
    // Group by task name so every run of the same task rolls up — the slow-hotspot key.
    familyHash: `schedule:${run.name}`,
    content,
    durationMs,
    origin: 'schedule',
    traceId,
    tags,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a registration + "now" to its {@link RegisteredSchedule}, computing `nextRunAt` for
 *  `cron`-kind entries. Exported so it's unit-testable without a live watcher. */
export function toRegisteredSchedule(reg: ScheduleRegistration, nowMs: number): RegisteredSchedule {
  const kind: ScheduleKind = reg.kind ?? 'cron';
  const schedule = typeof reg.schedule === 'string' ? reg.schedule : null;
  const timezone = typeof reg.timezone === 'string' ? reg.timezone : null;
  const nextRunMs =
    kind === 'cron' && schedule !== null ? nextCronRunMs(schedule, nowMs, timezone) : null;
  return {
    name: reg.name,
    kind,
    schedule,
    timezone,
    nextRunAt: nextRunMs !== null ? new Date(nextRunMs).toISOString() : null,
  };
}

/**
 * Register (or re-register) a schedule through the provider-published default watcher, so it shows
 * up in the dashboard's Live Schedules view. A NO-OP when the schedule watcher is not enabled, so
 * it's safe to call unconditionally (e.g. at the top of a boot file that wires up cron jobs).
 *
 * @example
 *   import { registerSchedule } from '@adonis-agora/telescope/watchers'
 *   registerSchedule({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' })
 */
export function registerSchedule(registration: ScheduleRegistration): void {
  getDefaultScheduleWatcher()?.register(registration);
}

/** Drop a registration through the provider-published default watcher. A no-op when the schedule
 *  watcher is not enabled or the name was never registered. */
export function unregisterSchedule(name: string): void {
  getDefaultScheduleWatcher()?.unregister(name);
}

/** Every registered schedule (with computed `nextRunAt`) through the provider-published default
 *  watcher, or `[]` when the schedule watcher is not enabled. */
export function listRegisteredSchedules(): RegisteredSchedule[] {
  return getDefaultScheduleWatcher()?.list() ?? [];
}

/**
 * Record one scheduled-task run through the provider-published default watcher.
 * A NO-OP when the schedule watcher is not enabled, so it is safe to call from a
 * scheduler callback unconditionally.
 *
 * @example
 *   import { recordScheduledRun } from '@adonis-agora/telescope/watchers'
 *   recordScheduledRun({ name: 'prune-sessions', status: 'completed', durationMs: 42 })
 */
export function recordScheduledRun(run: ScheduledRun): void {
  getDefaultScheduleWatcher()?.record(run);
}

/**
 * Time `fn` as a scheduled run through the provider-published default watcher. A
 * no-op passthrough (just runs `fn`) when the schedule watcher is not enabled.
 * This is the recommended integration point: wrap the closure you hand your
 * scheduler.
 *
 * @example
 *   import { scheduleTask } from '@adonis-agora/telescope/watchers'
 *   scheduler.call(() => scheduleTask('report', () => sendDailyReport())).daily()
 */
export function scheduleTask<T>(name: string, fn: () => T, options?: ScheduledTaskOptions): T {
  const watcher = getDefaultScheduleWatcher();
  if (watcher) return watcher.scheduleTask(name, fn, options);
  return fn();
}
