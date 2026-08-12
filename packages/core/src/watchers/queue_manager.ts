/**
 * The Live Queue Manager driver for the OPTIONAL `@adonisjs/queue` peer (whose engine is
 * `@boringnode/queue`).
 *
 * ## Why this does NOT mirror `nestjs-telescope`'s `BullMqQueueManager` operation-for-operation
 * `nestjs-telescope`'s `BullMqQueueManager` (`packages/bullmq/src/bull-mq-queue-manager.ts`) is
 * built on BullMQ, whose `Queue` exposes: enumerate/discover queues (via Nest's `DiscoveryService`),
 * `getJobCounts()` per state, `getJobs(state, start, end)` (paginated, BY STATE), `getJob(id)`,
 * `job.retry()`, `job.remove()`, `job.promote()`, and `queue.add()`. `@boringnode/queue` is a
 * DIFFERENT engine with a materially smaller public surface (checked against the published
 * `Adapter` interface across every release from 0.5.0 through the current 0.7.1 — the `Adapter`
 * type has not changed in that window):
 *
 *  - **SUPPORTED**: `Adapter.getJob(jobId, queue)` (single job by id), `Adapter.retryJob(jobId,
 *    queue, retryAt?)`, `Adapter.sizeOf(queue)` (a PENDING-only count), and enqueue via
 *    `Adapter.push`/`Adapter.pushOn` (the lower-level calls `Job.dispatch(payload).toQueue(name)`
 *    resolves to).
 *  - **NOT SUPPORTED — no such method exists on the `Adapter` interface, in any published version**:
 *    listing/paginating jobs BY STATE (there is no `getJobs`/`listJobs`/`findByStatus`), removing a
 *    job, promoting a delayed job, or per-state counts (`sizeOf` is pending-only; there is no
 *    `getJobCounts` equivalent). There is also no `listQueues()` — queues are just string names
 *    passed at dispatch time, with no registry to enumerate.
 *
 * Rather than fake the missing operations (a fabricated `listJobs` that silently returns `[]`, or a
 * `remove()` that no-ops and lies about succeeding), this driver ships EXACTLY what the engine
 * supports and advertises the rest as absent via {@link capabilities} — the same
 * "optional-method-presence advertises capability" idea `nestjs-telescope`'s `QueueManager` SPI
 * uses, computed here from what the resolved adapter itself exposes rather than guessed. A
 * dashboard built against this driver gets: configured queue names + a pending count, single-job
 * lookup by id, retry-by-id, and enqueue — a genuinely smaller but honest console.
 *
 * ## Why `queues` must be configured explicitly
 * `@boringnode/queue` has no `listQueues()` / registry to enumerate — queue names only exist as
 * strings passed at `.toQueue(name)` / dispatch time. So, like `nestjs-telescope`'s
 * `BullMqQueueManager` constructor's OPTIONAL `queueNames` allow-list (there, discovery is the
 * default and the list narrows it), here the list is NOT optional: there is nothing to discover, so
 * the host declares the queue names it wants surfaced (`config/telescope_watchers.ts`'s
 * `queueManager.queues`).
 *
 * ## Why the adapter is duck-typed rather than importing `@boringnode/queue`'s types
 * `@boringnode/queue` is not installed in THIS repo (same stance as `queue_watcher.ts`'s
 * `AcquiredJobLike`) — it is a peer the host app brings. {@link QueueAdapterLike} /
 * {@link QueueLike} model only the fields/methods this driver reads, read defensively.
 * {@link QueueLike.use} — resolving a specific named adapter off the top-level `queue` service via
 * `.use(name?)` — follows the standard AdonisJS "Manager" convention used throughout the framework
 * (`db.connection()`, `mail.use()`, `redis.connection()`, …); it was NOT directly confirmed against
 * `@boringnode/queue`'s public `.d.ts` (the research pass that grounded `retryJob`/`getJob`/`sizeOf`/
 * `push`/`pushOn` did not enumerate `QueueManager`'s own top-level methods), so this is a
 * well-precedented but unverified structural assumption — if a real app's `queue` service doesn't
 * expose `.use()`, {@link QueueManagerDriver} falls back to treating the service AS the adapter
 * directly (see `resolveAdapter`), and degrades to `configured === false` if neither shape matches.
 */

/** The job-execution states `@boringnode/queue`'s own `JobStatus` type distinguishes. Named exactly
 *  as the engine names them (NOT remapped to BullMQ's `waiting`/`paused` vocabulary) since this
 *  driver is not pretending to be a BullMQ-compatible surface. */
export type QueueState = 'pending' | 'active' | 'delayed' | 'failed' | 'completed';

export const QUEUE_STATES: readonly QueueState[] = [
  'pending',
  'active',
  'delayed',
  'failed',
  'completed',
];

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === 'string' && (QUEUE_STATES as readonly string[]).includes(value);
}

/** The mutating actions a driver MAY support; presence in {@link QueueManagerDriver.capabilities}
 *  (not mere method presence — see the module doc) is what the UI uses to show/hide the button. */
export type QueueActionName = 'retry' | 'remove' | 'promote' | 'enqueue';

export const QUEUE_ACTIONS: readonly QueueActionName[] = ['retry', 'remove', 'promote', 'enqueue'];

export function isQueueAction(value: unknown): value is QueueActionName {
  return typeof value === 'string' && (QUEUE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Per-state job counts. Every field is `number | null` (`null` = "this driver cannot report this
 * state's count") rather than a fabricated `0`, because `@boringnode/queue` genuinely cannot report
 * anything beyond a pending count today (see the module doc) — `0` would silently claim "empty" for
 * states the driver simply never asked about.
 */
export interface QueueCounts {
  pending: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  completed: number | null;
}

export interface QueueSummary {
  driver: string;
  queue: string;
  counts: QueueCounts;
  /** The mutating actions available for THIS queue (currently identical across queues for this
   *  driver — it varies per-queue only for drivers like SQS where only some queues have a DLQ). */
  actions: QueueActionName[];
}

/**
 * The structural slice of `@boringnode/queue`'s `JobRecord` this driver reads. NOT verified against
 * installed types (the peer isn't installed here — see the module doc); every field is optional so a
 * shape drift in the engine degrades to `null`/defaults rather than throwing.
 */
export interface QueueJobRecordLike {
  id?: string | number;
  name?: string;
  queue?: string;
  payload?: unknown;
  status?: string;
  attempts?: number;
  maxAttempts?: number;
  createdAt?: string | number | Date;
  processedAt?: string | number | Date | null;
  finishedAt?: string | number | Date | null;
  error?: string | null;
  result?: unknown;
}

export interface QueueJob {
  id: string;
  name: string | null;
  /** `null` when the record's `status` isn't one of {@link QUEUE_STATES} (unknown/engine-internal). */
  state: QueueState | null;
  attemptsMade: number | null;
  maxAttempts: number | null;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  failedReason: string | null;
}

export interface QueueJobDetail extends QueueJob {
  payload: unknown;
  result: unknown;
}

/**
 * Kept for interface parity with the NestJS sibling's paginated `JobPage` and for a FUTURE driver
 * that can genuinely list jobs (e.g. one that introspects a Knex-adapter jobs table directly rather
 * than going through `Adapter`) — {@link QueueManagerDriver} does NOT implement `listJobs` at all
 * (see the module doc), so this type is unused by the shipped driver today.
 */
export interface JobPage {
  jobs: QueueJob[];
  nextCursor: string | null;
  total: number | null;
}

/** What the UI's `GET .../queues/live` response advertises about mutation support. */
export interface QueueCapabilities {
  mutationsEnabled: boolean;
  actions: QueueActionName[];
}

/**
 * SPI a queue manager driver implements. `listJobs`/`remove`/`promote` are OPTIONAL (presence would
 * advertise capability for a future driver); {@link QueueManagerDriver} implements none of them —
 * see the module doc for why.
 */
export interface QueueManager {
  readonly driver: string;
  listQueues(): Promise<QueueSummary[]>;
  getJob(queue: string, id: string): Promise<QueueJobDetail | null>;
  listJobs?(
    queue: string,
    state: QueueState,
    page: { cursor?: string; limit?: number },
  ): Promise<JobPage>;
  retry?(queue: string, id: string): Promise<void>;
  remove?(queue: string, id: string): Promise<void>;
  promote?(queue: string, id: string): Promise<void>;
  enqueue?(
    queue: string,
    payload: unknown,
    opts: { name?: string },
  ): Promise<{ id: string | null }>;
  /**
   * OPTIONAL, more precise capability advertisement than method presence: a driver whose actions
   * depend on the RESOLVED RUNTIME adapter (not just which methods the class defines — see
   * {@link QueueManagerDriver.capabilities}) exposes this so route handlers check it FIRST, falling
   * back to `typeof manager[method] === 'function'` (the NestJS `BullMqQueueManager` convention,
   * still valid for a driver whose methods are unconditionally defined) when it's absent.
   */
  readonly capabilities?: QueueActionName[];
}

/** The structural slice of `@boringnode/queue`'s `Adapter` interface this driver calls — confirmed
 *  against the published `.d.ts` (see the module doc for exactly which methods were verified). */
export interface QueueAdapterLike {
  getJob(jobId: string, queue: string): Promise<QueueJobRecordLike | null>;
  retryJob?(jobId: string, queue: string, retryAt?: Date): Promise<void>;
  sizeOf?(queue: string): Promise<number>;
  size?(): Promise<number>;
  /** Enqueue onto the adapter's DEFAULT queue (the shape `Adapter.push` is documented with). */
  push?(payload: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  /** Enqueue onto a NAMED queue (the shape `Adapter.pushOn` is documented with). Preferred over
   *  `push` here since this driver always has an explicit target queue. */
  pushOn?(queue: string, payload: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

/** The structural slice of `@adonisjs/queue`'s exported `queue` service (itself a re-export of
 *  `@boringnode/queue`'s `QueueManager`) this driver resolves an adapter from. See the module doc's
 *  "unverified structural assumption" note on `.use()`. */
export interface QueueLike {
  use?(adapterName?: string): QueueAdapterLike;
}

export interface QueueManagerDriverOptions {
  /** Explicit queue names to surface — REQUIRED (see the module doc: there is no discovery API). */
  queues: string[];
  /** Which configured `@boringnode/queue` adapter to resolve via `queue.use(name)`. Omit to use the
   *  manager's own default adapter (`use()` with no argument). */
  adapter?: string;
}

/** Resolve the adapter this driver calls, or `null` when it can't be reached (peer absent / `.use`
 *  threw / neither the Manager nor the direct-adapter shape matched) — the driver stays fully
 *  constructible either way; `configured` reports the outcome for the UI. */
function resolveAdapter(
  queueService: QueueLike | null,
  adapterName: string | undefined,
): QueueAdapterLike | null {
  if (queueService === null) return null;
  try {
    if (typeof queueService.use === 'function') {
      return queueService.use(adapterName);
    }
    // No `.use` — tolerate a `queue` service that IS itself adapter-shaped (e.g. a single-adapter
    // setup, or a test double), rather than assuming the Manager convention unconditionally.
    const asAdapter = queueService as unknown as QueueAdapterLike;
    return typeof asAdapter.getJob === 'function' ? asAdapter : null;
  } catch {
    return null;
  }
}

/**
 * The Live Queue Manager driver for `@adonisjs/queue` / `@boringnode/queue`. Constructed by
 * `TelescopeWatchersProvider` from `config/telescope_watchers.ts`'s `queueManager` block, exactly
 * like the queue watcher's own opt-in stance: absent config / absent peer / an unresolvable adapter
 * all degrade to `configured === false` (an empty, clearly-labelled UI state), never a throw.
 */
export class QueueManagerDriver implements QueueManager {
  readonly driver = 'boringnode';
  private readonly adapter: QueueAdapterLike | null;
  private readonly queues: readonly string[];

  constructor(queueService: QueueLike | null, options: QueueManagerDriverOptions) {
    this.queues = options.queues;
    this.adapter = resolveAdapter(queueService, options.adapter);
  }

  /** Whether an adapter was actually resolved. `false` ⇒ every method below degrades safely
   *  (`listQueues` returns queues with all-null counts and no actions; `getJob` resolves `null`). */
  get configured(): boolean {
    return this.adapter !== null;
  }

  /** The mutating actions this driver can genuinely perform — derived from what the RESOLVED
   *  adapter exposes, not guessed. `remove`/`promote` are never included: `@boringnode/queue`'s
   *  `Adapter` interface exposes neither (see the module doc). */
  get capabilities(): QueueActionName[] {
    if (this.adapter === null) return [];
    const actions: QueueActionName[] = [];
    if (typeof this.adapter.retryJob === 'function') actions.push('retry');
    if (typeof this.adapter.pushOn === 'function' || typeof this.adapter.push === 'function') {
      actions.push('enqueue');
    }
    return actions;
  }

  async listQueues(): Promise<QueueSummary[]> {
    const actions = this.capabilities;
    return Promise.all(
      this.queues.map(async (queue) => ({
        driver: this.driver,
        queue,
        counts: await this.countsFor(queue),
        actions,
      })),
    );
  }

  private async countsFor(queue: string): Promise<QueueCounts> {
    const counts: QueueCounts = {
      pending: null,
      active: null,
      delayed: null,
      failed: null,
      completed: null,
    };
    if (this.adapter && typeof this.adapter.sizeOf === 'function') {
      try {
        counts.pending = await this.adapter.sizeOf(queue);
      } catch {
        // A count failure degrades to "unknown", never breaks the queue list.
      }
    }
    return counts;
  }

  async getJob(queue: string, id: string): Promise<QueueJobDetail | null> {
    if (this.adapter === null) return null;
    const raw = await this.adapter.getJob(id, queue);
    if (raw === null || raw === undefined) return null;
    return {
      ...toJob(raw),
      payload: raw.payload ?? null,
      result: raw.result ?? null,
    };
  }

  /** Throws when the resolved adapter has no `retryJob` — the route layer only calls this when
   *  {@link capabilities} already advertised `'retry'`, so this is a defensive backstop, not the
   *  primary gate. */
  async retry(queue: string, id: string): Promise<void> {
    if (!this.adapter?.retryJob) {
      throw new Error('This queue adapter does not support retrying a job.');
    }
    await this.adapter.retryJob(id, queue);
  }

  /**
   * Enqueue a new job. Prefers `pushOn(queue, payload, opts)` (explicit target queue) over
   * `push(payload, opts)` (the adapter's own default queue, with `queue` passed through `opts` on a
   * best-effort basis — some adapters read a `queue` option, some don't; see the module doc's
   * uncertainty note). Throws when neither is available.
   */
  async enqueue(
    queue: string,
    payload: unknown,
    opts: { name?: string } = {},
  ): Promise<{ id: string | null }> {
    if (this.adapter === null) {
      throw new Error('The queue adapter is not configured.');
    }
    const pushOpts = opts.name !== undefined ? { name: opts.name } : {};
    if (typeof this.adapter.pushOn === 'function') {
      const result = await this.adapter.pushOn(queue, payload, pushOpts);
      return { id: idOf(result) };
    }
    if (typeof this.adapter.push === 'function') {
      const result = await this.adapter.push(payload, { ...pushOpts, queue });
      return { id: idOf(result) };
    }
    throw new Error('This queue adapter does not support enqueueing a job.');
  }
}

/** Map a raw job record to its public {@link QueueJob} projection. */
function toJob(raw: QueueJobRecordLike): QueueJob {
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : null,
    state: isQueueState(status) ? status : null,
    attemptsMade: typeof raw.attempts === 'number' ? raw.attempts : null,
    maxAttempts: typeof raw.maxAttempts === 'number' ? raw.maxAttempts : null,
    createdAt: toIso(raw.createdAt),
    processedAt: toIso(raw.processedAt),
    finishedAt: toIso(raw.finishedAt),
    failedReason: typeof raw.error === 'string' ? raw.error : null,
  };
}

function toIso(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Best-effort extraction of an id off whatever `push`/`pushOn`/`retryJob` resolve with — the exact
 *  return shape of the `Adapter` push family wasn't confirmed (see the module doc), so this reads
 *  defensively rather than assuming a specific shape. */
function idOf(result: unknown): string | null {
  if (typeof result === 'string' || typeof result === 'number') return String(result);
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return null;
}
