/**
 * The minimal HTTP surface the JSON API handlers and the auth guard read/write,
 * kept deliberately framework-light so handlers are unit-testable with a plain
 * object (no running AdonisJS server). An Adonis `HttpContext` satisfies this
 * structurally — `request.qs()`, `request.header()`, and a `response` that can
 * set a status and a body — so the provider passes the real `ctx` straight
 * through.
 */

/** The slice of an inbound request the UI reads. */
export interface UiRequest {
  /** The request method, upper- or lower-cased (`GET`, `get`). */
  method(): string;
  /** The parsed query string as a flat record (Adonis `request.qs()`). */
  qs(): Record<string, unknown>;
  /** A single request header by (case-insensitive) name, or `undefined`. */
  header(name: string): string | undefined;
}

/** The slice of an outbound response the UI writes. */
export interface UiResponse {
  /** Set the HTTP status code; returns `this` for chaining (Adonis-compatible). */
  status(code: number): UiResponse;
  /** Set a response header; returns `this` for chaining (Adonis-compatible). */
  header(name: string, value: string): UiResponse;
  /** Send a body (object → JSON, string → as-is). Terminal. */
  send(body: unknown): unknown;
}

/** A framework-light HTTP context: just the request + response slices above. */
export interface UiHttpContext {
  request: UiRequest;
  response: UiResponse;
}

/**
 * A tiny in-memory {@link UiResponse} for tests and for capturing a handler's
 * output without a live server. Records the last status/headers/body written.
 */
export class RecordingResponse implements UiResponse {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  body: unknown = undefined;
  sent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  send(body: unknown): unknown {
    this.body = body;
    this.sent = true;
    return body;
  }
}

// ─────────────────────────────── SSE live-stream ───────────────────────────────
// (additive: the Server-Sent-Events surface used by the live-stream route)

/**
 * The slice of an outbound HTTP response the SSE stream writes to: raw chunks plus
 * a close handler. Framework-light so the stream handler is unit-testable with a
 * plain in-memory sink (no running server). An Adonis `response.response` (the
 * underlying Node `ServerResponse`) satisfies this structurally via
 * `writeHead`/`write`/`end`/`on('close')`.
 */
export interface SseSink {
  /** Write a raw chunk (a fully-formatted SSE frame) to the socket. */
  write(chunk: string): void;
  /** Register a one-shot client-disconnect handler; returns nothing. */
  onClose(handler: () => void): void;
}

/**
 * Format one Server-Sent-Events frame. `data` is JSON-encoded onto a single
 * `data:` line; an optional `event` name is prefixed. Always terminated by the
 * blank line that delimits SSE frames.
 *
 * ```text
 * event: entry\n
 * data: {"type":"request",...}\n
 * \n
 * ```
 */
export function formatSseFrame(data: unknown, event?: string): string {
  const payload = JSON.stringify(data);
  const prefix = event !== undefined ? `event: ${event}\n` : '';
  return `${prefix}data: ${payload}\n\n`;
}

/** A comment-only SSE keep-alive line (ignored by clients, keeps the socket warm). */
export function formatSseHeartbeat(): string {
  return ': heartbeat\n\n';
}

/**
 * A tiny in-memory {@link SseSink} for tests: captures every written frame and
 * lets a test trigger the client-disconnect path via {@link RecordingSink.close}.
 */
export class RecordingSink implements SseSink {
  readonly chunks: string[] = [];
  closed = false;
  private readonly closeHandlers: Array<() => void> = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** Simulate a client disconnect, firing every registered close handler once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
  }
}

/** Build a plain {@link UiRequest} from a method, query record, and headers. */
export function makeRequest(
  method: string,
  qs: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): UiRequest {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    method: () => method,
    qs: () => qs,
    header: (name) => lower[name.toLowerCase()],
  };
}
