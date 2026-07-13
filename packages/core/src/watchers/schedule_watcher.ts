import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
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
 * Idiomatic Adonis: a plain class, no DI decorators. The provider constructs it
 * from `config/telescope_watchers.ts` and calls {@link start} to publish it as the
 * default backing the bare {@link scheduleTask} / {@link recordScheduledRun}
 * helpers; {@link stop} unpublishes.
 */
export class ScheduleWatcher {
  readonly type = EntryType.ScheduledTask;
  private readonly slowMs: number;
  private readonly clock: { now(): number };

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

  /** Unpublish this instance as the default (if it is). Never touches globals. */
  stop(): void {
    if (getDefaultScheduleWatcher() === this) setDefaultScheduleWatcher(null);
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

  const tags: string[] = ['schedule', `schedule:${kind}`, `task:${run.name}`, `status:${run.status}`];
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
export function scheduleTask<T>(
  name: string,
  fn: () => T,
  options?: ScheduledTaskOptions,
): T {
  const watcher = getDefaultScheduleWatcher();
  if (watcher) return watcher.scheduleTask(name, fn, options);
  return fn();
}
