import diagnostics_channel from 'node:diagnostics_channel';
import { currentTraceId } from '../context_accessor.js';
import { isTelescopeWork } from '../self_scope.js';
import {
  isPropagationTarget,
  originOf,
  propagatesOutbound,
  type ResolvedPropagationConfig,
} from './config.js';
import { currentOtelSpan, currentTraceScope, isOtelTracingActive } from './scope.js';
import { formatTraceparent, newSpanId } from './traceparent.js';

/**
 * Outgoing propagation: adds `traceparent` (and the caller's `tracestate`) to the calls this app
 * makes to the configured targets.
 *
 * Hooked on the `diagnostics_channel` undici publishes for every request it creates — every
 * `fetch`, whatever dispatcher the app set (a `ProxyAgent` installed after boot included) —
 * which is the same hook OpenTelemetry's undici instrumentation uses. `node:http` has its own
 * channel, used only with `nodeHttp: true`.
 *
 * Never injects twice: a request that already carries `traceparent` (set by your code, or by
 * OpenTelemetry) is left alone, and while OpenTelemetry tracing runs in the process telescope
 * leaves propagation to it entirely.
 */

/** undici publishes this when it creates a request (Node's bundled `fetch` included). */
export const UNDICI_REQUEST_CREATE = 'undici:request:create';
/** Node publishes this when an `http.request` / `https.request` is created, before it is sent. */
export const HTTP_CLIENT_REQUEST_CREATED = 'http.client.request.created';

/** The trace headers an outgoing call made now would carry, or `null` outside any trace. */
export function outgoingTraceHeaders(): { traceparent: string; tracestate?: string } | null {
  const traceId = currentTraceId();
  if (traceId === null || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  const scope = currentTraceScope();
  // The active OpenTelemetry span when there is one (a job dispatched under OTel), else this
  // request's or job's own span.
  const spanId = currentOtelSpan()?.spanId ?? scope?.spanId ?? newSpanId();
  const traceparent = formatTraceparent(traceId, spanId, scope?.flags);
  // The caller's tracestate belongs to the caller's trace: forwarded only within it.
  const tracestate =
    scope?.tracestate !== undefined &&
    (scope.upstreamTraceId === traceId || scope.fallbackTraceId === traceId)
      ? scope.tracestate
      : undefined;
  return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
}

/** The slice of an undici `Request` the hook reads. */
interface UndiciRequestLike {
  origin?: unknown;
  headers?: unknown;
  addHeader?(name: string, value: string): unknown;
}

/** The slice of a `node:http` `ClientRequest` the hook reads. */
interface ClientRequestLike {
  protocol?: unknown;
  host?: unknown;
  headersSent?: boolean;
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

function undiciHasTraceparent(headers: unknown): boolean {
  if (typeof headers === 'string') return /(^|\r\n)traceparent:/i.test(headers);
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === 'traceparent') return true;
    }
  }
  return false;
}

function undiciOrigin(request: UndiciRequestLike): string | null {
  const origin = request.origin;
  if (typeof origin === 'string') return originOf(origin);
  if (origin instanceof URL) return originOf(origin.href);
  return null;
}

function clientRequestOrigin(request: ClientRequestLike): string | null {
  const protocol = typeof request.protocol === 'string' ? request.protocol : 'http:';
  const hostHeader = request.getHeader?.('host');
  const host =
    typeof hostHeader === 'string'
      ? hostHeader
      : typeof request.host === 'string'
        ? request.host
        : '';
  if (host === '') return null;
  return originOf(`${protocol}//${host}`);
}

/** The headers for a call to `origin`, or `null` when it must carry none. */
function headersFor(config: ResolvedPropagationConfig, origin: string | null) {
  if (isTelescopeWork()) return null;
  if (isOtelTracingActive()) return null;
  if (!isPropagationTarget(config.targets, origin)) return null;
  return outgoingTraceHeaders();
}

/** Inject into one undici request. Exported for tests. */
export function injectIntoUndiciRequest(
  config: ResolvedPropagationConfig,
  request: UndiciRequestLike,
): void {
  if (typeof request.addHeader !== 'function') return;
  if (undiciHasTraceparent(request.headers)) return;
  const headers = headersFor(config, undiciOrigin(request));
  if (headers === null) return;
  request.addHeader('traceparent', headers.traceparent);
  if (headers.tracestate !== undefined) request.addHeader('tracestate', headers.tracestate);
}

/** Inject into one `node:http` request. Exported for tests. */
export function injectIntoClientRequest(
  config: ResolvedPropagationConfig,
  request: ClientRequestLike,
): void {
  if (typeof request.setHeader !== 'function' || request.headersSent === true) return;
  if (request.getHeader?.('traceparent') !== undefined) return;
  const headers = headersFor(config, clientRequestOrigin(request));
  if (headers === null) return;
  request.setHeader('traceparent', headers.traceparent);
  if (headers.tracestate !== undefined) request.setHeader('tracestate', headers.tracestate);
}

const INSTALLED = Symbol.for('@agora/telescope:outbound-propagation');
type Installed = { undici: (msg: unknown) => void; http: ((msg: unknown) => void) | null };
const slot = globalThis as Record<symbol, unknown>;

/**
 * Start adding trace headers to outgoing calls (replacing a previous install). Returns the
 * function that stops it. A no-op when `targets` is empty.
 */
export function installOutboundPropagation(config: ResolvedPropagationConfig): () => void {
  uninstallOutboundPropagation();
  if (!propagatesOutbound(config)) return () => {};
  const undici = (message: unknown) => {
    try {
      const request = (message as { request?: UndiciRequestLike } | null)?.request;
      if (request) injectIntoUndiciRequest(config, request);
    } catch {
      // Propagation never breaks the call.
    }
  };
  diagnostics_channel.subscribe(UNDICI_REQUEST_CREATE, undici);
  let http: Installed['http'] = null;
  if (config.nodeHttp) {
    http = (message: unknown) => {
      try {
        const request = (message as { request?: ClientRequestLike } | null)?.request;
        if (request) injectIntoClientRequest(config, request);
      } catch {
        // Propagation never breaks the call.
      }
    };
    diagnostics_channel.subscribe(HTTP_CLIENT_REQUEST_CREATED, http);
  }
  const installed: Installed = { undici, http };
  slot[INSTALLED] = installed;
  return () => {
    if (slot[INSTALLED] === installed) uninstallOutboundPropagation();
  };
}

/** Stop adding trace headers to outgoing calls. */
export function uninstallOutboundPropagation(): void {
  const installed = slot[INSTALLED] as Installed | undefined;
  if (installed === undefined) return;
  diagnostics_channel.unsubscribe(UNDICI_REQUEST_CREATE, installed.undici);
  if (installed.http !== null) {
    diagnostics_channel.unsubscribe(HTTP_CLIENT_REQUEST_CREATED, installed.http);
  }
  slot[INSTALLED] = undefined;
}
