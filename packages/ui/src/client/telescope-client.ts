import { resolveApiBase } from './api-base.js';
import type {
  ArmOutcome,
  ArmProfileResult,
  DiagnoseOutcome,
  DiagnosisResult,
  EnqueueOutcome,
  EntriesQuery,
  Entry,
  EntrySummary,
  Envelope,
  Page,
  ScreenStats,
  LiveQueues,
  LiveSchedules,
  NPlusOnePattern,
  ProfilerStatus,
  PulseSummary,
  QueueJobDetail,
  ReplayOutcome,
  ReplayResult,
  RetentionInfo,
  RetryJobOutcome,
  StatsOverview,
  StatsResult,
  TelescopeMeta,
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

  /** Unwrap a `{ data, meta }` envelope into a {@link Page}, keeping the paging meta
   *  that {@link data} throws away. */
  private async page<T>(
    path: string,
    query: Record<string, string> = {},
  ): Promise<Page<T>> {
    const body = await this.get<Envelope<T[]>>(path, query);
    const meta = body.meta ?? {};
    return {
      rows: body.data,
      page: typeof meta.page === 'number' ? meta.page : 1,
      hasMore: meta.hasMore === true,
    };
  }

  /**
   * POST with no request body (every mutation route this client calls — diagnose, replay — takes
   * its parameters from the URL/query string, mirroring the routes themselves). Reads the JSON body
   * even on failure so a `{ error }` message can be surfaced instead of a generic status line.
   */
  private async post<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.base}${path}${search ? `?${search}` : ''}`;
    const response = await this.doFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<Envelope<T>> & { error?: string })
      | null;
    if (!response.ok) {
      throw new TelescopeApiError(
        body?.error ?? `POST ${path} failed (${response.status})`,
        response.status,
      );
    }
    return (body as Envelope<T>).data;
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

  /** One page of entries, with whether a next page exists. */
  listEntriesPage(query: EntriesQuery = {}): Promise<Page<EntrySummary>> {
    return this.page<EntrySummary>(
      '/entries',
      toQuery({
        type: query.type,
        tag: query.tag,
        traceId: query.traceId,
        search: query.search,
        before: query.before,
        limit: query.limit ?? this.limit,
        page: query.page ?? 1,
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

  metricsStats(
    type: string,
    windowMs?: number,
    buckets?: number,
    topExceptions?: number,
  ): Promise<StatsResult> {
    return this.data<StatsResult>(
      '/metrics/stats',
      toQuery({ type, windowMs, buckets, topExceptions }),
    );
  }

  metricsTimeseries(windowMs?: number, buckets?: number, type?: string): Promise<TimeseriesReport> {
    return this.data<TimeseriesReport>('/metrics/timeseries', toQuery({ windowMs, buckets, type }));
  }

  /** Per-route traffic over a window, optionally narrowed to page visits or API calls. */
  screens(windowMs?: number, kind?: string, limit?: number): Promise<ScreenStats[]> {
    return this.data<ScreenStats[]>('/metrics/screens', toQuery({ windowMs, kind, limit }));
  }

  traces(limit = this.limit): Promise<TraceSummary[]> {
    return this.data<TraceSummary[]>('/metrics/traces', toQuery({ limit }));
  }

  /** One page of traces, with whether a next page exists. */
  tracesPage(limit = this.limit, page = 1): Promise<Page<TraceSummary>> {
    return this.page<TraceSummary>('/metrics/traces', toQuery({ limit, page }));
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

  // ── retention / extension dashboards ────────────────────────────────────

  /** The configured retention window + which entry types are sampled below 100%. */
  retention(): Promise<RetentionInfo> {
    return this.data<RetentionInfo>('/retention');
  }

  /**
   * The dashboards + entry types contributed by every registered extension. Only
   * registered server-side when at least one extension is configured — a `404`
   * (no extension registry booted) is treated as "nothing contributed" rather
   * than an error, so an install with zero extensions renders an empty state
   * instead of a fetch failure.
   */
  async meta(): Promise<TelescopeMeta> {
    try {
      return await this.data<TelescopeMeta>('/meta');
    } catch (err) {
      if (err instanceof TelescopeApiError && err.status === 404) {
        return { entryTypes: [], dashboards: [] };
      }
      throw err;
    }
  }

  /** Resolve one extension panel's named data provider (`{ext}/{provider}`). */
  extData<T>(ext: string, provider: string, query: Record<string, string> = {}): Promise<T> {
    return this.data<T>(
      `/ext/${encodeURIComponent(ext)}/data/${encodeURIComponent(provider)}`,
      query,
    );
  }

  // ── AI exception diagnosis ──────────────────────────────────────────────

  /**
   * Diagnose (or re-diagnose, with `force`) an `exception`/`client_exception` entry via
   * `POST /exceptions/:id/diagnose`. Never throws — a 404 (not configured / not an exception) or a
   * 502 (model call failed/timed out) resolves to `{ ok: false, message }` so the panel can render
   * the failure inline instead of an error boundary.
   */
  async diagnoseException(entryId: string, force = false): Promise<DiagnoseOutcome> {
    try {
      const result = await this.post<DiagnosisResult>(
        `/exceptions/${encodeURIComponent(entryId)}/diagnose`,
        force ? { force: 'true' } : {},
      );
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof TelescopeApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  // ── request replay ──────────────────────────────────────────────────────

  /**
   * Re-issue a captured `request` entry against the live server via
   * `POST /requests/:id/replay`. Never throws — a 403 (disabled) or 404 (not a request entry)
   * resolves to `{ ok: false, message }` so the panel can render why inline.
   */
  async replayRequest(entryId: string): Promise<ReplayOutcome> {
    try {
      const result = await this.post<ReplayResult>(
        `/requests/${encodeURIComponent(entryId)}/replay`,
      );
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof TelescopeApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  // ── CPU profiling ────────────────────────────────────────────────────────

  /** The profiler's current sampling/arm state. `null` when the feature isn't installed. */
  async profilerStatus(): Promise<ProfilerStatus | null> {
    try {
      return await this.data<ProfilerStatus>('/profiles/status');
    } catch (err) {
      if (err instanceof TelescopeApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Captured profiles newest-first, without their frame tree. */
  profiles(limit = 100): Promise<EntrySummary[]> {
    return this.data<EntrySummary[]>('/profiles', toQuery({ limit }));
  }

  /** One captured profile's full entry (with its flamegraph tree + hot frames). */
  profile(id: string): Promise<Entry> {
    return this.data<Entry>(`/profiles/${encodeURIComponent(id)}`);
  }

  /** Arm an on-demand capture of the next `count` requests, optionally matching `label`. Never
   *  throws on a "disabled"/bad-input 4xx — resolves `{ ok: false, message }` instead. */
  async armProfile(count: number, label?: string): Promise<ArmOutcome> {
    try {
      const result = await this.post<ArmProfileResult>('/profiles/arm', toQuery({ count, label }));
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof TelescopeApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  // ── live queue manager ──────────────────────────────────────────────────

  /** Configured queues + capabilities. `null` when the capability isn't installed/configured. */
  async liveQueues(): Promise<LiveQueues | null> {
    try {
      return await this.data<LiveQueues>('/queues/live');
    } catch (err) {
      if (err instanceof TelescopeApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** One job's detail, or `null` when unknown/not configured. */
  async queueJob(queue: string, id: string): Promise<QueueJobDetail | null> {
    try {
      return await this.data<QueueJobDetail>(
        `/queues/live/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      if (err instanceof TelescopeApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Retry a job by id. Never throws on a "disabled"/unsupported 4xx/501. */
  async retryJob(queue: string, id: string): Promise<RetryJobOutcome> {
    try {
      await this.post(
        `/queues/live/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}/retry`,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof TelescopeApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /** Enqueue a new job onto `queue`. Never throws on a "disabled"/unsupported 4xx/501. */
  async enqueueJob(queue: string, payload: unknown, name?: string): Promise<EnqueueOutcome> {
    try {
      const url = `${this.base}/queues/live/${encodeURIComponent(queue)}/enqueue`;
      const response = await this.doFetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(name !== undefined ? { name, payload } : { payload }),
      });
      const body = (await response.json().catch(() => null)) as
        | (Partial<Envelope<{ id: string | null }>> & { error?: string })
        | null;
      if (!response.ok) {
        return { ok: false, message: body?.error ?? `enqueue failed (${response.status})` };
      }
      return { ok: true, id: (body as Envelope<{ id: string | null }>).data.id };
    } catch (err) {
      if (err instanceof TelescopeApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  // ── live schedules ───────────────────────────────────────────────────────

  liveSchedules(): Promise<LiveSchedules> {
    return this.data<LiveSchedules>('/schedules/live');
  }
}
