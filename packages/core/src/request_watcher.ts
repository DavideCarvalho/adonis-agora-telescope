import { type Entry, EntryType, type RecordInput } from './entry.js';
import type { TelescopeStore } from './store.js';

/** The recorded body of a `request` entry. */
export interface RequestEntryContent {
  /** HTTP method, upper-cased (`GET`, `POST`, …). */
  method: string;
  /** Request path (no query string), e.g. `/users/42`. */
  url: string;
  /** Response status code, or `null` if it could not be determined. */
  status: number | null;
  /** Request duration in milliseconds. */
  durationMs: number;
  /** The active trace id at request time, or `null`. */
  traceId: string | null;
  /**
   * Captured request body — present ONLY when the request exposes a body and it
   * passed the {@link RequestCaptureOptions} gates. A gated-out body is a marker
   * string (e.g. `'[Skipped: 200000 bytes > 131072 bytes]'`); an omitted `body`
   * means no body was exposed (e.g. a GET, or a stub without a `body()` accessor).
   */
  body?: unknown;
}

/**
 * Default `requestCapture.maxBodyBytes`: bodies over 128 KiB are not captured.
 * ON by default — the safe-by-default guard so a synchronous redaction walk over
 * a giant decoded body never stalls the event loop.
 */
export const DEFAULT_MAX_BODY_BYTES = 131_072;

/**
 * Default `requestCapture.skipBodyContentTypes`: binary/streamed/multipart upload
 * bodies whose captured "payload" is never useful and can be arbitrarily large.
 */
export const DEFAULT_SKIP_BODY_CONTENT_TYPES: readonly (string | RegExp)[] = [
  'application/octet-stream',
  'application/offset+octet-stream',
  'multipart/form-data',
];

/** The request info handed to a {@link RequestCaptureOptions.skipBody} predicate. */
export interface CaptureRequestInfo {
  method: string;
  url: string;
  /** The request's `content-type` header, or `undefined`. */
  contentType: string | undefined;
  /** The raw (pre-redaction) body the gate is deciding on. */
  body: unknown;
}

/**
 * Gates for capturing the request body, applied BEFORE the synchronous redaction
 * walk so a huge or binary body is never walked. All gates are ON by default; a
 * matched gate replaces the body with a marker string, leaving every other
 * request-entry field untouched.
 */
export interface RequestCaptureOptions {
  /**
   * Skip capturing bodies larger than this many bytes (measured O(1) via
   * `content-length` or a string/Buffer/TypedArray length — never by serializing
   * a parsed body). Default 131072 (128 KiB); `false` disables the size gate.
   */
  maxBodyBytes?: number | false;
  /**
   * Content-type patterns whose bodies are never captured: a `string` matches as
   * a case-insensitive PREFIX (so `'multipart/form-data'` matches a `; boundary=`
   * suffix); a `RegExp` is `.test()`-ed. Default: binary/streamed/multipart.
   */
  skipBodyContentTypes?: (string | RegExp)[];
  /** Host predicate: return `true` to skip capturing this request's body. */
  skipBody?: (request: CaptureRequestInfo) => boolean;
}

/** Resolved (defaults-applied) {@link RequestCaptureOptions}. */
export interface ResolvedRequestCapture {
  maxBodyBytes: number | false;
  skipBodyContentTypes: (string | RegExp)[];
  skipBody: ((request: CaptureRequestInfo) => boolean) | undefined;
}

/** Apply the requestCapture defaults to a (possibly partial) config. */
export function resolveRequestCapture(
  options: RequestCaptureOptions | undefined,
): ResolvedRequestCapture {
  return {
    maxBodyBytes: options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    skipBodyContentTypes: options?.skipBodyContentTypes ?? [...DEFAULT_SKIP_BODY_CONTENT_TYPES],
    skipBody: options?.skipBody,
  };
}

/** The minimal slice of an Adonis HttpContext the watcher reads. */
export interface RequestLike {
  method(): string;
  url(): string;
  /** Parsed request body, when the platform exposes one. */
  body?(): unknown;
  /** A single request header by (case-insensitive) name, when exposed. */
  header?(name: string): string | string[] | number | undefined;
}
export interface ResponseLike {
  response: { statusCode?: number };
}
export interface HttpContextLike {
  request: RequestLike;
  response: ResponseLike['response'];
}

/** Options for {@link recordRequest}. */
export interface RecordRequestOptions {
  /** Override the duration; defaults to `Date.now() - startedAt`. */
  durationMs?: number;
  /** The trace id; defaults to the one the store resolves from context. */
  traceId?: string | null;
  /**
   * Body-capture gates. When present (and the request exposes a `body()`), the
   * body is captured through these gates — content-type, then size, then the host
   * predicate — with defaults applied. Omit to skip body capture entirely (the
   * pre-existing behavior: no `body` field on the entry).
   */
  capture?: RequestCaptureOptions;
}

/** First string value of a header read via the platform accessor. */
function headerString(request: RequestLike, name: string): string | undefined {
  const value = request.header?.(name);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Parsed `content-length`, or `undefined` when absent/non-numeric/negative. */
function contentLengthOf(request: RequestLike): number | undefined {
  const raw = headerString(request, 'content-length');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Whether `contentType` matches any pattern: a `string` matches as a
 * case-insensitive PREFIX; a `RegExp` is `.test()`-ed against the raw value.
 */
function matchesContentType(contentType: string, patterns: (string | RegExp)[]): boolean {
  const lower = contentType.toLowerCase();
  return patterns.some((pattern) =>
    typeof pattern === 'string'
      ? lower.startsWith(pattern.toLowerCase())
      : pattern.test(contentType),
  );
}

/**
 * O(1) byte-size estimate for the size gate: the `content-length` header when
 * present, else a string/Buffer/TypedArray body's own length. Deliberately NEVER
 * serializes a parsed body to measure it — that IS the synchronous walk this gate
 * exists to avoid — so a parsed-object body without `content-length` returns
 * `undefined` and the size gate is skipped for it (the content-type / skipBody
 * gates still apply).
 */
function estimateBodyBytes(body: unknown, contentLength: number | undefined): number | undefined {
  if (contentLength !== undefined) return contentLength;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

/**
 * Apply the requestCapture gates (content-type → size → predicate) to the raw
 * request body BEFORE it reaches the store's redaction walk. Returns the body
 * unchanged when every gate passes, or a marker string when a gate trips.
 */
function gateRequestBody(request: RequestLike, capture: ResolvedRequestCapture): unknown {
  const body = request.body?.() ?? null;
  const contentType = headerString(request, 'content-type');

  if (contentType !== undefined && matchesContentType(contentType, capture.skipBodyContentTypes)) {
    return `[Skipped: ${contentType}]`;
  }
  if (capture.maxBodyBytes !== false) {
    const bytes = estimateBodyBytes(body, contentLengthOf(request));
    if (bytes !== undefined && bytes > capture.maxBodyBytes) {
      return `[Skipped: ${bytes} bytes > ${capture.maxBodyBytes} bytes]`;
    }
  }
  if (capture.skipBody?.({ method: request.method(), url: request.url(), contentType, body })) {
    return '[Skipped: skipBody predicate]';
  }
  return body;
}

/**
 * The pure, framework-agnostic core of the HTTP request watcher: build a
 * `request` {@link RecordInput} from a (stubbable) HttpContext-like value and a
 * start timestamp, and record it. Kept out of the middleware so it is trivially
 * unit-testable with a plain object. Resolves to the recorded {@link Entry}.
 */
export async function recordRequest(
  store: TelescopeStore,
  ctx: HttpContextLike,
  startedAt: number,
  options: RecordRequestOptions = {},
): Promise<Entry<RequestEntryContent>> {
  const method = String(ctx.request.method()).toUpperCase();
  const url = stripQuery(ctx.request.url());
  const status = typeof ctx.response.statusCode === 'number' ? ctx.response.statusCode : null;
  const durationMs = options.durationMs ?? Math.max(0, Date.now() - startedAt);

  // Body capture (gated). Only when the caller opted in AND the request exposes a
  // body accessor. The gate runs HERE — before the store's synchronous redaction
  // walk — so a huge/binary body is replaced by a marker and never walked; a body
  // that passes every gate is captured and still redacted downstream.
  const captureBody =
    options.capture !== undefined && typeof ctx.request.body === 'function'
      ? gateRequestBody(ctx.request, resolveRequestCapture(options.capture))
      : undefined;

  const input: RecordInput<RequestEntryContent> = {
    type: EntryType.Request,
    content: {
      method,
      url,
      status,
      durationMs,
      traceId: options.traceId ?? null,
      ...(captureBody !== undefined ? { body: captureBody } : {}),
    },
    durationMs,
    origin: 'http',
    tags: [`method:${method}`, ...(status !== null ? [`status:${status}`] : [])],
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
  };

  const recorded = await store.record(input);
  // Backfill the content trace id from whatever the store resolved (context).
  recorded.content.traceId = recorded.traceId;
  return recorded;
}

/** Drop a `?query=string` suffix from a url. */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
