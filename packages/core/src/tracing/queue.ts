import diagnostics_channel from 'node:diagnostics_channel';
import { isTelescopeWork } from '../self_scope.js';
import { outgoingTraceHeaders } from './outbound.js';
import { newTraceScope, type TraceScope, traceScopeStorage } from './scope.js';
import { parseTraceparent, parseTracestate } from './traceparent.js';

/**
 * Trace context through `@adonisjs/queue` jobs.
 *
 * `@boringnode/queue` (the engine behind `@adonisjs/queue`) gives every job a `traceContext`
 * carrier (W3C `traceparent` / `tracestate`), saved with the job by every adapter, and publishes
 * tracing channels around dispatch and execution:
 *
 * - on dispatch, telescope writes the current trace into each job's `traceContext`, unless it
 *   already has a `traceparent` (OpenTelemetry's queue instrumentation, or your code, set one);
 * - on execution, the job runs in a scope continuing that trace, so everything it records (and
 *   every call or job it makes) belongs to the request that dispatched it, in whichever app the
 *   worker runs.
 */

const DISPATCH = 'boringqueue.job.dispatch';
const EXECUTE = 'boringqueue.job.execute';
const DISPATCH_START = diagnostics_channel.tracingChannel(DISPATCH).start.name;
const EXECUTE_START = diagnostics_channel.tracingChannel(EXECUTE).start.name;

/** The slice of a `@boringnode/queue` job the hooks read and write. */
interface JobDataLike {
  traceContext?: Record<string, string>;
}

/** Write the current trace into the jobs of a dispatch message. Exported for tests. */
export function injectIntoJobs(message: unknown): void {
  if (isTelescopeWork()) return;
  const jobs = (message as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  const headers = outgoingTraceHeaders();
  if (headers === null) return;
  for (const job of jobs as JobDataLike[]) {
    if (job === null || typeof job !== 'object') continue;
    const carrier = job.traceContext;
    if (carrier !== undefined && typeof carrier.traceparent === 'string') continue;
    job.traceContext = { ...(carrier ?? {}), ...headers };
  }
}

/** The scope a job runs in: its dispatcher's trace, or `current` when it carries none. */
export function scopeForJob(message: unknown, current: TraceScope | undefined) {
  const job = (message as { job?: JobDataLike } | null)?.job;
  const carrier = job?.traceContext;
  const parent = parseTraceparent(carrier?.traceparent);
  if (parent === undefined) return current;
  return newTraceScope(parent, parseTracestate(carrier?.tracestate));
}

const INSTALLED = Symbol.for('@agora/telescope:queue-propagation');
const slot = globalThis as Record<symbol, unknown>;

/** Start carrying the trace through queue jobs (replacing a previous install). Returns the stop function. */
export function installQueuePropagation(): () => void {
  uninstallQueuePropagation();
  const storage = traceScopeStorage();
  const onDispatch = (message: unknown) => {
    try {
      injectIntoJobs(message);
    } catch {
      // Propagation never breaks a dispatch.
    }
  };
  diagnostics_channel.subscribe(DISPATCH_START, onDispatch);
  // `bindStore`: the engine runs the job inside `start.runStores(...)`, so the job, and every
  // promise it creates, sees the scope.
  diagnostics_channel.channel(EXECUTE_START).bindStore(storage, (message) => {
    try {
      return scopeForJob(message, storage.getStore()) as TraceScope;
    } catch {
      return storage.getStore() as TraceScope;
    }
  });
  const installed = { onDispatch };
  slot[INSTALLED] = installed;
  return () => {
    if (slot[INSTALLED] === installed) uninstallQueuePropagation();
  };
}

/** Stop carrying the trace through queue jobs. */
export function uninstallQueuePropagation(): void {
  const installed = slot[INSTALLED] as { onDispatch: (message: unknown) => void } | undefined;
  if (installed === undefined) return;
  diagnostics_channel.unsubscribe(DISPATCH_START, installed.onDispatch);
  diagnostics_channel.channel(EXECUTE_START).unbindStore(traceScopeStorage());
  slot[INSTALLED] = undefined;
}
