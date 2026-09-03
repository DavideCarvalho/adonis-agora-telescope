import diagnostics_channel from 'node:diagnostics_channel';
import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { safeRecord } from './record.js';

/**
 * The `node:diagnostics_channel` tracing channel `@boringnode/queue` (the engine
 * behind the OPTIONAL peer `@adonisjs/queue`) publishes a job EXECUTION trace on.
 * A tracing channel fires the sub-channels `<name>:start`, `:end`, `:asyncStart`,
 * `:asyncEnd`, and `:error` around the traced async operation; we read the outcome
 * off `:asyncEnd` (status/duration/error are mutated onto the same message during
 * the trace's async lifecycle).
 *
 * `@adonisjs/queue` is not installed in this repo, so the payload shape is sourced
 * from the engine's `src/tracing_channels.ts` rather than verified against
 * installed types (the engine is pre-1.0, so this surface can drift). The channel
 * NAME, however, is derived from Node's own `tracingChannel` rather than assumed —
 * ver {@link ASYNC_END_CHANNEL}. The watcher degrades to a pure no-op when nobody
 * publishes on the channel — i.e. when the peer is absent.
 */
export const QUEUE_EXECUTE_CHANNEL = 'boringqueue.job.execute';

/**
 * Sub-channel the tracing channel fires once a traced execution settles.
 *
 * O prefixo `tracing:` NÃO é decoração: é como o Node nomeia os sub-canais de um
 * `diagnostics_channel.tracingChannel(name)` — `tracing:<name>:start`, `:asyncEnd`, etc. Assinar
 * `<name>:asyncEnd` cria um canal novo, que ninguém publica, e o watcher fica surdo em silêncio.
 *
 * Era o caso até aqui, e em produção isso aparecia como `type=job` em ZERO com o worker
 * executando jobs normalmente. Um watcher que não recebe nada é indistinguível de um sistema sem
 * jobs — que é o pior formato possível de falha para uma ferramenta de observabilidade.
 *
 * Derivado do `tracingChannel` em vez de escrito à mão, para que o nome venha do Node e não de
 * uma suposição sobre o Node. `subscribe`/`unsubscribe` do próprio objeto seriam mais diretos,
 * mas o watcher precisa só do `asyncEnd`, e o `subscribe` do tracing channel exige o conjunto
 * inteiro de handlers.
 */
const ASYNC_END_CHANNEL = diagnostics_channel.tracingChannel(QUEUE_EXECUTE_CHANNEL).asyncEnd.name;

/** The terminal outcome of a single job execution attempt. */
export type JobStatus = 'completed' | 'failed' | 'retrying';

/**
 * The structural slice of a single acquired job, as `@boringnode/queue` shapes it
 * (`AcquiredJob`). Read defensively (every field optional) — the exact runtime
 * shape is owned by the engine and could not be verified here.
 */
export interface AcquiredJobLike {
  id?: string;
  name?: string;
  payload?: unknown;
  attempts?: number;
}

/**
 * The structural slice of the `boringqueue.job.execute` tracing message read at
 * `:asyncEnd`. `status`, `duration`, and `error` are populated by the engine on the
 * way out of the trace.
 */
export interface JobExecuteMessageLike {
  job?: AcquiredJobLike;
  queue?: string;
  status?: JobStatus;
  /** Execution duration in ms, set by the engine on completion. */
  duration?: number;
  error?: unknown;
}

/** The recorded body of a `job` entry. */
export interface JobEntryContent {
  /** The job id, or `null` when the engine did not carry one. */
  id: string | null;
  /** The job class name (e.g. `'SendWelcomeEmail'`), or `null`. */
  name: string | null;
  /** The queue the job ran on (e.g. `'default'`), or `null`. */
  queue: string | null;
  /** The job payload (redaction applies downstream). `null` when absent. */
  payload: unknown;
  /** The execution outcome. */
  status: JobStatus;
  /** How many attempts the job had made, or `null`. */
  attempts: number | null;
  /** The failure message when `status` is `'failed'`/`'retrying'`, else `null`. */
  failureReason: string | null;
  /** The active trace id at execution time, or `null`. */
  traceId: string | null;
}

/** Options for {@link QueueWatcher}. */
export interface QueueWatcherOptions {
  /** Jobs whose execution time is >= this (ms) get a `slow` tag. Default 1000. */
  slowMs?: number;
}

/** Default slow-job threshold in milliseconds. */
const DEFAULT_SLOW_MS = 1000;

/** Narrow an unknown tracing message to the structural shape we read. */
function toMessage(msg: unknown): JobExecuteMessageLike {
  return typeof msg === 'object' && msg !== null ? (msg as JobExecuteMessageLike) : {};
}

/**
 * Records every `@adonisjs/queue` job EXECUTION as a `job` telescope entry —
 * capturing the queue, job name, payload, outcome (completed/failed/retrying),
 * attempts and duration, correlated to the active trace.
 *
 * ## How it works
 * `@adonisjs/queue`'s engine (`@boringnode/queue`) publishes a
 * `node:diagnostics_channel` TRACING channel per execution attempt
 * ({@link QUEUE_EXECUTE_CHANNEL}). The watcher subscribes to its `:asyncEnd`
 * sub-channel — fired once the execution settles, with `status`/`duration`/`error`
 * populated — and records one entry per attempt. Subscribing is what flips the
 * channel's `hasSubscribers` on; with no publisher (peer absent) it is a no-op.
 *
 * Like the other watchers, recording is fire-and-forget and fully guarded: a
 * telescope failure can never break or block a job.
 */
export class QueueWatcher {
  readonly type = EntryType.Job;
  private readonly slowMs: number;
  private handler: ((msg: unknown) => void) | null = null;

  constructor(options: QueueWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  }

  /** Subscribe to the queue execution trace. Idempotent. */
  start(): void {
    if (this.handler) return;
    const handler = (msg: unknown) => this.handle(msg);
    this.handler = handler;
    diagnostics_channel.channel(ASYNC_END_CHANNEL).subscribe(handler);
  }

  /** Unsubscribe from the queue execution trace. Safe to call when never started. */
  stop(): void {
    if (!this.handler) return;
    diagnostics_channel.channel(ASYNC_END_CHANNEL).unsubscribe(this.handler);
    this.handler = null;
  }

  private handle(msg: unknown): void {
    safeRecord(buildJobEntry(toMessage(msg), this.slowMs), 'QueueWatcher');
  }
}

/** Map a queue execution message to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without a real diagnostics publish. */
export function buildJobEntry(
  message: JobExecuteMessageLike,
  slowMs = DEFAULT_SLOW_MS,
): RecordInput<JobEntryContent> {
  const job = message.job ?? {};
  const id = typeof job.id === 'string' ? job.id : null;
  const name = typeof job.name === 'string' ? job.name : null;
  const queue = typeof message.queue === 'string' ? message.queue : null;
  const status: JobStatus = message.status ?? 'completed';
  const attempts = typeof job.attempts === 'number' ? job.attempts : null;
  const durationMs = typeof message.duration === 'number' ? Math.max(0, message.duration) : null;
  const failed = status === 'failed' || status === 'retrying';
  const failureReason = failed && message.error !== undefined ? errorMessage(message.error) : null;
  const traceId = currentTraceId();

  const content: JobEntryContent = {
    id,
    name,
    queue,
    payload: job.payload ?? null,
    status,
    attempts,
    failureReason,
    traceId,
  };

  const tags: string[] = ['queue', `status:${status}`];
  if (queue) tags.push(`queue:${queue}`);
  if (name) tags.push(`job:${name}`);
  if (failed) tags.push('failed');
  if (durationMs !== null && durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.Job,
    familyHash: [queue, name].filter(Boolean).join(':') || null,
    content,
    durationMs,
    traceId,
    tags,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
