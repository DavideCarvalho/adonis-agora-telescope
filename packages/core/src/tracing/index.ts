import type { ResolvedPropagationConfig } from './config.js';
import { installOutboundPropagation } from './outbound.js';
import { installQueuePropagation } from './queue.js';
import { currentOtelSpan, currentTraceScope, newTraceScope, type TraceScope } from './scope.js';
import { parseTraceparent, parseTracestate } from './traceparent.js';

export {
  isPropagationTarget,
  type PropagationConfig,
  type ResolvedPropagationConfig,
  resolvePropagation,
} from './config.js';
export { outgoingTraceHeaders } from './outbound.js';
export {
  currentSpanIds,
  currentTraceScope,
  runInTraceScope,
  type TraceScope,
} from './scope.js';
export {
  formatTraceparent,
  parseTraceparent,
  parseTracestate,
  type TraceParent,
} from './traceparent.js';

/** What the request middleware reads: whether to continue callers, whether to start traces. */
interface TracingRuntime {
  incoming: boolean;
  /** Start a trace for a request no caller sent one for (`propagation` is configured). */
  startTraces: boolean;
}

const RUNTIME = Symbol.for('@agora/telescope:tracing-runtime');
const slot = globalThis as Record<symbol, unknown>;
const DEFAULT_RUNTIME: TracingRuntime = { incoming: true, startTraces: false };

function tracingRuntime(): TracingRuntime {
  return (slot[RUNTIME] as TracingRuntime | undefined) ?? DEFAULT_RUNTIME;
}

/**
 * Turn propagation on for this process: outgoing calls to the targets, queue jobs, and the
 * request middleware's handling of incoming `traceparent`. Returns the function that turns it off.
 *
 * @param configured whether the app set `propagation` (only then does a request with no caller
 * start a trace of its own).
 */
export function installPropagation(
  config: ResolvedPropagationConfig,
  configured: boolean,
): () => void {
  const runtime: TracingRuntime = { incoming: config.incoming, startTraces: configured };
  slot[RUNTIME] = runtime;
  const stopOutbound = installOutboundPropagation(config);
  const stopQueue = config.queue ? installQueuePropagation() : () => {};
  return () => {
    stopOutbound();
    stopQueue();
    if (slot[RUNTIME] === runtime) slot[RUNTIME] = undefined;
  };
}

/** The slice of a request the middleware hands over. */
interface HeaderReader {
  header?(name: string): unknown;
}

/**
 * The scope an incoming request runs in, or `undefined` to run it as is: when OpenTelemetry has a
 * span for it (OTel continued the caller already), when a scope is active, or when there is no
 * caller and propagation is not configured.
 */
export function traceScopeForRequest(request: HeaderReader): TraceScope | undefined {
  if (currentTraceScope() !== undefined || currentOtelSpan() !== undefined) return undefined;
  const runtime = tracingRuntime();
  let parent: ReturnType<typeof parseTraceparent>;
  let tracestate: string | undefined;
  if (runtime.incoming) {
    try {
      parent = parseTraceparent(request.header?.('traceparent'));
      tracestate =
        parent === undefined ? undefined : parseTracestate(request.header?.('tracestate'));
    } catch {
      parent = undefined;
    }
  }
  if (parent === undefined && !runtime.startTraces) return undefined;
  return newTraceScope(parent, tracestate);
}
