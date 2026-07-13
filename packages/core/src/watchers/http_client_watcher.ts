import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { normalizeHttpTarget } from './normalize_http_target.js';
import { safeRecord } from './record.js';

/** Options for {@link HttpClientWatcher} / {@link instrumentFetch}. */
export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a `slow` tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default `Date.now`. */
  clock?: { now(): number };
  /**
   * Hosts whose calls are NOT recorded (exact host match, case-insensitive; the
   * host may include a port, e.g. `localhost:6379`). Use to drop noisy internal
   * targets — a remote telescope store, a metrics sink — from the timeline.
   */
  ignoreHosts?: string[];
  /**
   * When `true`, record the request/response body SIZES (bytes, never the bytes
   * themselves) into the entry content. Request size is read from `init.body`;
   * response size from the `content-length` header (the response stream is never
   * consumed). Default `false`.
   */
  captureBodies?: boolean;
}

/** The recorded body of an `http-client` entry. */
export interface HttpClientEntryContent {
  /** The request method, upper-cased (e.g. `'GET'`). */
  method: string;
  /** The sanitized request url (userinfo stripped, sensitive query values masked). */
  url: string;
  /** The target host (e.g. `'api.stripe.com'`), or `null` for a relative/invalid url. */
  host: string | null;
  /** The response status, or `null` on a transport (network) failure. */
  statusCode: number | null;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  /** The active trace id at call time, or `null`. */
  traceId: string | null;
  /** Request body size in bytes when `captureBodies` is on and measurable, else `null`. */
  requestBytes: number | null;
  /** Response body size (from `content-length`) when `captureBodies` is on, else `null`. */
  responseBytes: number | null;
  /** The transport error message on a network failure, else `null`. */
  error: string | null;
}

/** A single captured outbound call — the input to {@link buildHttpClientEntry}
 *  and the manual {@link HttpClientWatcher.record} helper. */
export interface OutgoingCall {
  method: string;
  url: string;
  host: string | null;
  statusCode: number | null;
  durationMs: number;
  requestBytes?: number | null;
  responseBytes?: number | null;
  error?: string | null;
}

/** Default slow-call threshold in milliseconds. */
const DEFAULT_SLOW_MS = 1000;

/** Query-param keys whose VALUES are masked from a captured URL. Key-based
 *  content redaction can't reach a URL string leaf, so we sanitize the URL here
 *  before it ever reaches the (separately redacted) entry content. */
const SENSITIVE_PARAM =
  /(token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|credential)/i;
const REDACTED = '[REDACTED]';

/** Marks an `init` (RequestInit) as telescope's OWN outbound call so the wrapper
 *  skips recording it — the recursion guard for any internal fetch (e.g. a
 *  remote store / alert webhook performing a `fetch` through an instrumented
 *  client). */
const INTERNAL = Symbol.for('@agora/telescope:internalFetch');

/** Cross-copy-stable slot holding the provider-configured default watcher, so a
 *  bare `instrumentFetch(fetch)` (no options) inherits the app's configured
 *  `slowMs` / `ignoreHosts` / `captureBodies`. A `Symbol.for` global slot (not a
 *  module local) keeps two copies of this package in agreement — the same stance
 *  the runtime registry uses. */
const DEFAULT_SLOT = Symbol.for('@agora/telescope:defaultHttpClientWatcher');
const slotHost = globalThis as typeof globalThis & { [DEFAULT_SLOT]?: HttpClientWatcher | null };

function setDefaultHttpClientWatcher(watcher: HttpClientWatcher | null): void {
  slotHost[DEFAULT_SLOT] = watcher;
}
function getDefaultHttpClientWatcher(): HttpClientWatcher | null {
  return slotHost[DEFAULT_SLOT] ?? null;
}

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

/**
 * Sanitize a raw URL for storage: strip userinfo (`user:pass@`) and mask
 * sensitive query-param VALUES, returning `{ url, host }`. A relative/invalid
 * url is kept verbatim with `host: null`.
 */
function sanitizeUrl(rawUrl: string): { url: string; host: string | null } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.host;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return { url: parsed.toString(), host };
  } catch {
    return { url: rawUrl, host: null };
  }
}

/** Pull method/url/host out of fetch's `(input, init)` without throwing. */
function describeRequest(
  input: FetchInput,
  init: FetchInit,
): { method: string; url: string; host: string | null } {
  let rawUrl = '';
  let method = 'GET';
  if (typeof input === 'string') rawUrl = input;
  else if (input instanceof URL) rawUrl = input.href;
  else if (input instanceof Request) {
    rawUrl = input.url;
    method = input.method;
  }
  if (init && typeof init.method === 'string') method = init.method;

  const { url, host } = sanitizeUrl(rawUrl);
  return { method: method.toUpperCase(), url, host };
}

/** Best-effort byte size of a fetch request body, without consuming a stream.
 *  Returns `null` for shapes whose size can't be read cheaply (ReadableStream,
 *  FormData, a `Request`'s stream body). Never throws. */
function requestByteLength(init: FetchInit): number | null {
  const value = init && 'body' in init ? (init as { body?: unknown }).body : undefined;
  if (value === undefined || value === null) return null;
  try {
    if (typeof value === 'string') return Buffer.byteLength(value);
    if (value instanceof URLSearchParams) return Buffer.byteLength(value.toString());
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
    const size = (value as { size?: unknown }).size;
    if (typeof size === 'number') return size; // Blob / File
  } catch {
    return null;
  }
  return null;
}

/** Response body size from the `content-length` header, or `null`. The header is
 *  read (not the stream), so the host's `response.json()`/`.text()` is untouched. */
function responseByteLength(response: Response): number | null {
  const raw = response.headers?.get?.('content-length');
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Mark a `RequestInit` so an instrumented fetch skips recording the call it
 *  belongs to. Use for telescope's own outbound fetches (remote store, alert
 *  webhooks) so the watcher never records — or recurses on — itself. */
export function markInternalFetch(init: FetchInit): FetchInit {
  const next = (init ?? {}) as FetchInit & { [INTERNAL]?: boolean };
  next[INTERNAL] = true;
  return next;
}

/**
 * Records OUTBOUND HTTP calls as `http-client` telescope entries — **opt-in, with
 * no global monkey-patching**. AdonisJS has no single built-in HTTP client, so
 * this never replaces `globalThis.fetch`; instead you wrap a `fetch`
 * implementation with {@link HttpClientWatcher.instrumentFetch} (or the
 * standalone {@link instrumentFetch}) and hand the wrapper to your client, or
 * record a non-`fetch` call yourself via {@link HttpClientWatcher.record}.
 *
 * The wrapper never alters the host's call: it awaits the real `fetch`, records
 * fire-and-forget through {@link safeRecord} (which honours the overload-shed
 * `paused` flag and applies redaction/sampling on the store's write path), and
 * always re-throws a network error. Calls to an `ignoreHosts` target, and
 * telescope's own outbound fetches (marked via {@link markInternalFetch}), are
 * skipped.
 *
 * Each entry carries `familyHash` (`METHOD host/normalized-path`) and
 * `durationMs`, so it feeds the Pulse `slowOutgoing` hotspot card directly.
 *
 * Idiomatic Adonis: a plain class, no DI decorators. The provider constructs it
 * from `config/telescope_watchers.ts` and calls {@link start} to publish it as
 * the default backing a bare `instrumentFetch(fetch)`; {@link stop} unpublishes.
 * Neither touches any global.
 */
export class HttpClientWatcher {
  readonly type = EntryType.HttpClient;
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  private readonly ignoreHosts: Set<string>;
  private readonly captureBodies: boolean;

  constructor(options: HttpClientWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.ignoreHosts = new Set((options.ignoreHosts ?? []).map((host) => host.toLowerCase()));
    this.captureBodies = options.captureBodies ?? false;
  }

  /** Publish this configured instance as the default that a bare
   *  {@link instrumentFetch} (called with no explicit options) inherits config
   *  from. Does NOT patch any global — instrumentation stays opt-in. Named
   *  `start`/`stop` to match the other watchers' provider lifecycle. */
  start(): void {
    setDefaultHttpClientWatcher(this);
  }

  /** Unpublish this instance as the default (if it is). Never touches globals. */
  stop(): void {
    if (getDefaultHttpClientWatcher() === this) setDefaultHttpClientWatcher(null);
  }

  /**
   * Wrap a `fetch` implementation so every call it makes is recorded as an
   * `http-client` entry — WITHOUT mutating any global. The returned function has
   * `fetch`'s signature; pass it to your HTTP client, or call it directly.
   *
   * @example
   *   const trackedFetch = new HttpClientWatcher().instrumentFetch(globalThis.fetch)
   *   await trackedFetch('https://api.stripe.com/v1/charges')
   */
  instrumentFetch(fetchImpl: FetchFn = globalThis.fetch): FetchFn {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('instrumentFetch: a fetch implementation is required.');
    }
    const watcher = this;
    const wrapped = async function instrumentedFetch(
      input: FetchInput,
      init?: FetchInit,
    ): Promise<Response> {
      // Skip telescope's own outbound calls — the recursion guard.
      if (init && (init as { [INTERNAL]?: boolean })[INTERNAL]) {
        return fetchImpl(input, init);
      }

      const { method, url, host } = describeRequest(input, init);
      // An ignored host is passed straight through, unrecorded and un-timed.
      if (host !== null && watcher.ignoreHosts.has(host.toLowerCase())) {
        return fetchImpl(input, init);
      }

      const startedAt = watcher.clock.now();
      const requestBytes = watcher.captureBodies ? requestByteLength(init) : null;
      try {
        const response = await fetchImpl(input, init);
        watcher.record({
          method,
          url,
          host,
          statusCode: response.status,
          durationMs: watcher.clock.now() - startedAt,
          requestBytes,
          responseBytes: watcher.captureBodies ? responseByteLength(response) : null,
          error: null,
        });
        return response;
      } catch (error) {
        watcher.record({
          method,
          url,
          host,
          statusCode: null,
          durationMs: watcher.clock.now() - startedAt,
          requestBytes,
          responseBytes: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error; // never swallow the host's network error
      }
    } as FetchFn;
    return wrapped;
  }

  /**
   * Record one already-completed outbound call — the small helper for HTTP
   * clients that are NOT `fetch`-based (axios, got, an undici stream). Compute
   * the fields at your call site and hand them here; recording is fire-and-forget
   * and never throws. Honours `ignoreHosts` and the overload-shed flag.
   */
  record(call: OutgoingCall): void {
    if (call.host !== null && this.ignoreHosts.has(call.host.toLowerCase())) return;
    safeRecord(buildHttpClientEntry(call, this.slowMs), 'HttpClientWatcher');
  }
}

/**
 * Wrap a `fetch` implementation so its calls are recorded — the standalone,
 * zero-boilerplate opt-in hook. With no `options`, it inherits the config the
 * provider published via {@link HttpClientWatcher.start} (falling back to
 * defaults when telescope's watcher isn't wired). Pass `options` to instrument
 * with an isolated, explicitly-configured watcher.
 *
 * @example
 *   import { instrumentFetch } from '@adonis-agora/telescope/watchers'
 *   const trackedFetch = instrumentFetch(globalThis.fetch)
 */
export function instrumentFetch(
  fetchImpl: FetchFn = globalThis.fetch,
  options?: HttpClientWatcherOptions,
): FetchFn {
  const watcher = options
    ? new HttpClientWatcher(options)
    : (getDefaultHttpClientWatcher() ?? new HttpClientWatcher());
  return watcher.instrumentFetch(fetchImpl);
}

/** Map a captured outbound call to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without instrumenting a real client. */
export function buildHttpClientEntry(
  call: OutgoingCall,
  slowMs = DEFAULT_SLOW_MS,
): RecordInput<HttpClientEntryContent> {
  const traceId = currentTraceId();
  const content: HttpClientEntryContent = {
    method: call.method,
    url: call.url,
    host: call.host,
    statusCode: call.statusCode,
    durationMs: Math.max(0, call.durationMs),
    traceId,
    requestBytes: call.requestBytes ?? null,
    responseBytes: call.responseBytes ?? null,
    error: call.error ?? null,
  };
  const tags: string[] = ['http-client'];
  if (content.host) tags.push(`host:${content.host}`);
  // A 4xx is a valid response, not a transport failure — only 5xx / network errors are 'failed'.
  if (content.statusCode === null || content.statusCode >= 500) tags.push('failed');
  if (content.durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.HttpClient,
    // Group by method + host + normalized path so the same external endpoint
    // aggregates regardless of ids — the Pulse slow-outgoing hotspot key.
    familyHash: normalizeHttpTarget(content.method, content.url),
    content,
    durationMs: content.durationMs,
    traceId,
    tags,
  };
}
