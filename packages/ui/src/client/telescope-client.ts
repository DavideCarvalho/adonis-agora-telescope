import { resolveApiBase } from './api-base.js';
import type {
  EntriesQuery,
  Entry,
  EntrySummary,
  Envelope,
  NPlusOnePattern,
  PulseSummary,
  StatsOverview,
  StatsResult,
  TimeseriesReport,
  TraceSummary,
  Waterfall,
} from './types.js';

/** Thrown on a non-2xx response, carrying the HTTP status for the UI to branch on. */
export class TelescopeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TelescopeApiError';
  }
}

type FetchLike = typeof fetch;

export interface TelescopeClientOptions {
  /** API base (e.g. `/telescope/api`). Defaults to the injected/derived base for the current page. */
  baseUrl?: string;
  /** Injectable `fetch` (tests pass a stub). Defaults to the global. */
  fetch?: FetchLike;
  /** Default cap for list feeds; the server clamps to 500. Defaults to 50. */
  limit?: number;
}

/** Drop `undefined`/empty values and stringify the rest into a query record. */
function toQuery(params: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * A framework-free browser client for the `@adonis-agora/telescope` UI provider's READ surface: the
 * entries list + detail, per-trace list/waterfall/N+1, per-type metrics, and the Pulse health
 * rollup. Same-origin, `credentials: 'same-origin'` so the host's auth cookie / dev policy gates
 * every call exactly as it gates the routes server-side. No third-party HTTP dependency. The live
 * tail is a separate {@link streamUrl} consumed by an `EventSource` in the view layer.
 */
export class TelescopeClient {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly limit: number;

  constructor(options: TelescopeClientOptions = {}) {
    this.base = (options.baseUrl ?? resolveApiBase()).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.limit = options.limit ?? 50;
  }

  /** The absolute URL of the SSE live-stream route, for `new EventSource(url)`. */
  streamUrl(): string {
    return `${this.base}/stream`;
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.base}${path}${search ? `?${search}` : ''}`;
    const response = await this.doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new TelescopeApiError(`GET ${path} failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  }

  /** Unwrap the standard `{ data }` envelope. */
  private async data<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const body = await this.get<Envelope<T>>(path, query);
    return body.data;
  }

  // ── entries ──────────────────────────────────────────────────────────────

  listEntries(query: EntriesQuery = {}): Promise<EntrySummary[]> {
    return this.data<EntrySummary[]>(
      '/entries',
      toQuery({
        type: query.type,
        tag: query.tag,
        traceId: query.traceId,
        search: query.search,
        before: query.before,
        limit: query.limit ?? this.limit,
      }),
    );
  }

  getEntry(id: string): Promise<Entry> {
    return this.data<Entry>(`/entries/${encodeURIComponent(id)}`);
  }

  entriesByTrace(traceId: string): Promise<EntrySummary[]> {
    return this.data<EntrySummary[]>(`/trace/${encodeURIComponent(traceId)}`);
  }

  stats(limit = 10, type?: string): Promise<StatsOverview> {
    return this.data<StatsOverview>('/stats', toQuery({ limit, type }));
  }

  // ── metrics ──────────────────────────────────────────────────────────────

  metricsStats(type: string, windowMs?: number, buckets?: number): Promise<StatsResult> {
    return this.data<StatsResult>('/metrics/stats', toQuery({ type, windowMs, buckets }));
  }

  metricsTimeseries(windowMs?: number, buckets?: number, type?: string): Promise<TimeseriesReport> {
    return this.data<TimeseriesReport>('/metrics/timeseries', toQuery({ windowMs, buckets, type }));
  }

  traces(limit = this.limit): Promise<TraceSummary[]> {
    return this.data<TraceSummary[]>('/metrics/traces', toQuery({ limit }));
  }

  waterfall(traceId: string): Promise<Waterfall> {
    return this.data<Waterfall>(`/metrics/waterfall/${encodeURIComponent(traceId)}`);
  }

  nPlusOne(traceId: string, threshold?: number): Promise<NPlusOnePattern[]> {
    return this.data<NPlusOnePattern[]>(
      `/metrics/n-plus-one/${encodeURIComponent(traceId)}`,
      toQuery({ threshold }),
    );
  }

  pulse(windowMs?: number, topN?: number): Promise<PulseSummary> {
    return this.data<PulseSummary>('/metrics/pulse', toQuery({ windowMs, topN }));
  }
}
