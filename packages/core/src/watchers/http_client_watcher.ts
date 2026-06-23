import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { normalizeHttpTarget } from './normalize_http_target.js';
import { safeRecord } from './record.js';

/** Options for {@link HttpClientWatcher}. */
export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a `slow` tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default `Date.now`. */
  clock?: { now(): number };
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
}

/** Default slow-call threshold in milliseconds. */
const DEFAULT_SLOW_MS = 1000;

/** Query-param keys whose VALUES are masked from a captured URL. Key-based
 *  content redaction can't reach a URL string leaf, so we sanitize the URL here
 *  before it ever reaches the (separately redacted) entry content. */
const SENSITIVE_PARAM =
  /(token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|credential)/i;
const REDACTED = '[REDACTED]';

/** Marks our wrapper so the global `fetch` is patched exactly once even if two
 *  copies of this package load. `Symbol.for` (the global registry) is deliberate:
 *  both copies resolve the same marker and neither double-wraps the other. */
const PATCHED = Symbol.for('@agora/telescope:httpClientPatched');

/** Marks an `init` (RequestInit) as telescope's OWN outbound call so the wrapper
 *  skips recording it — the recursion guard for any internal fetch (e.g. a
 *  future remote store / alert webhook performing a `fetch`). */
const INTERNAL = Symbol.for('@agora/telescope:internalFetch');

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

/** A `fetch` wrapper carrying our idempotency marker + the original it replaced. */
interface PatchedFetch extends FetchFn {
  [PATCHED]?: boolean;
  __telescopeOriginal__?: FetchFn;
}

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

/** Mark a `RequestInit` so the {@link HttpClientWatcher} skips recording the
 *  call it belongs to. Use for telescope's own outbound fetches (remote store,
 *  alert webhooks) so the watcher never records — or recurses on — itself. */
export function markInternalFetch(init: FetchInit): FetchInit {
  const next = (init ?? {}) as FetchInit & { [INTERNAL]?: boolean };
  next[INTERNAL] = true;
  return next;
}

/**
 * Records every OUTBOUND HTTP call as an `http-client` telescope entry by
 * wrapping the Node global `fetch`. Each call is timed; method, sanitized url,
 * host, status and duration are captured and correlated to the active request
 * via the trace id.
 *
 * The wrapper never alters the host's call: it awaits the real `fetch`, records
 * fire-and-forget (a telescope failure can't break or block the request), and
 * always re-throws a network error. Telescope's own outbound fetches — marked
 * via {@link markInternalFetch} — are skipped, so the watcher never records or
 * recurses on itself.
 *
 * Patching the global is idempotent process-wide (a `Symbol.for` marker). Unlike
 * the emitter watchers, this implements its own lifecycle: `start()` takes no
 * emitter; `stop()` restores the original `fetch`.
 */
export class HttpClientWatcher {
  readonly type = EntryType.HttpClient;
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  /** Whether THIS instance installed the patch (so only it restores on stop). */
  private installed = false;

  constructor(options: HttpClientWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  /** Patch `globalThis.fetch` to record outbound calls. Idempotent: a second
   *  call (or another instance / package copy) is a no-op. */
  start(): void {
    const current = globalThis.fetch as PatchedFetch | undefined;
    if (typeof current !== 'function' || current[PATCHED]) return;

    const original = current;
    const watcher = this;
    const patched = async function patchedFetch(
      input: FetchInput,
      init?: FetchInit,
    ): Promise<Response> {
      // Skip (and don't record) telescope's own outbound calls — the recursion
      // guard for any internal fetch.
      if (init && (init as { [INTERNAL]?: boolean })[INTERNAL]) {
        return original(input, init);
      }

      const startedAt = watcher.clock.now();
      const { method, url, host } = describeRequest(input, init);
      try {
        const response = await original(input, init);
        watcher.record(method, url, host, response.status, watcher.clock.now() - startedAt);
        return response;
      } catch (error) {
        watcher.record(method, url, host, null, watcher.clock.now() - startedAt);
        throw error; // never swallow the host's network error
      }
    } as PatchedFetch;

    patched[PATCHED] = true;
    patched.__telescopeOriginal__ = original;
    globalThis.fetch = patched;
    this.installed = true;
  }

  /** Restore the original `fetch` — but only if THIS instance installed the
   *  current wrapper (avoids clobbering a wrapper a later instance installed). */
  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    const current = globalThis.fetch as PatchedFetch | undefined;
    if (current?.[PATCHED] && current.__telescopeOriginal__) {
      globalThis.fetch = current.__telescopeOriginal__;
    }
  }

  /** Build + record an entry, swallowing every failure via {@link safeRecord}. */
  private record(
    method: string,
    url: string,
    host: string | null,
    statusCode: number | null,
    durationMs: number,
  ): void {
    safeRecord(
      buildHttpClientEntry({ method, url, host, statusCode, durationMs }, this.slowMs),
      'HttpClientWatcher',
    );
  }
}

/** Map a captured outbound call to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without patching the global. */
export function buildHttpClientEntry(
  call: {
    method: string;
    url: string;
    host: string | null;
    statusCode: number | null;
    durationMs: number;
  },
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
  };
  const tags: string[] = ['http-client'];
  if (content.host) tags.push(`host:${content.host}`);
  // A 4xx is a valid response, not a transport failure — only 5xx / network errors are 'failed'.
  if (content.statusCode === null || content.statusCode >= 500) tags.push('failed');
  if (content.durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.HttpClient,
    familyHash: normalizeHttpTarget(content.method, content.url),
    content,
    durationMs: content.durationMs,
    traceId,
    tags,
  };
}
