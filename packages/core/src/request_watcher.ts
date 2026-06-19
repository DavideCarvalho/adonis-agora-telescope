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
}

/** The minimal slice of an Adonis HttpContext the watcher reads. */
export interface RequestLike {
  method(): string;
  url(): string;
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

  const input: RecordInput<RequestEntryContent> = {
    type: EntryType.Request,
    content: {
      method,
      url,
      status,
      durationMs,
      traceId: options.traceId ?? null,
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
