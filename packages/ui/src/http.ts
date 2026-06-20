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
