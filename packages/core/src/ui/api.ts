import { EntryType } from '../entry.js';
import type { Entry } from '../entry.js';
import { MetricsService, type MetricsServiceOptions } from '../metrics/metrics_service.js';
import type { RequestEntryContent } from '../request_watcher.js';
import type { TelescopeService } from '../service.js';
import type { EntryQuery } from '../store.js';
import type { UiHttpContext, UiRequest } from './http.js';
import { type ReplayOptions, type ReplayResult, replayRequest } from './request_replay.js';

/** Default number of entries returned by the list endpoint when no `limit` is given. */
const DEFAULT_LIMIT = 50;
/** Hard ceiling on `limit` so a hostile query string can't ask for everything. */
const MAX_LIMIT = 500;

/**
 * The JSON-API handler functions over a {@link TelescopeService}. Each takes the
 * framework-light {@link UiHttpContext} (an Adonis `HttpContext` satisfies it) plus
 * the service, reads query/route params off the request, and writes a JSON body to
 * the response. No DI, no router — trivially unit-testable with a plain object.
 */
export class TelescopeApi {
  private readonly metrics: MetricsService;
  /** Request-replay settings (additive). Replay is disabled unless `enabled`. */
  private readonly replay: { enabled: boolean } & ReplayOptions;

  constructor(
    private readonly service: TelescopeService,
    metricsOptions: MetricsServiceOptions = {},
    replayOptions: ({ enabled?: boolean } & ReplayOptions) | undefined = undefined,
  ) {
    this.metrics = new MetricsService(service.telescopeStore, metricsOptions);
    this.replay = { enabled: false, ...replayOptions };
  }

  /**
   * `GET <path>/api/entries` — list entries newest-first, with optional filters:
   * `?type=`, `?traceId=`, `?search=`, `?limit=` (capped), `?before=` (ISO date).
   */
  async list(ctx: UiHttpContext): Promise<unknown> {
    const query = buildQuery(ctx.request);
    const entries = await this.service.list(query);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({
        data: entries.map(toSummary),
        meta: { count: entries.length, query: describe(query) },
      });
  }

  /** `GET <path>/api/entries/:id` — one entry with its full `content`, or 404. */
  async show(ctx: UiHttpContext, id: string): Promise<unknown> {
    const entry = await this.service.find(id);
    if (entry === null) {
      return ctx.response.status(404).send({ error: 'Entry not found' });
    }
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: entry });
  }

  /** `GET <path>/api/trace/:traceId` — every entry under a trace, newest-first. */
  async trace(ctx: UiHttpContext, traceId: string): Promise<unknown> {
    const entries = await this.service.byTrace(traceId);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: entries.map(toSummary), meta: { traceId, count: entries.length } });
  }

  /**
   * `GET <path>/api/stats` — dashboard aggregates: total count, top families, and
   * top tags. `?limit=` caps each top-N list; `?type=` scopes `topFamilies`.
   */
  async stats(ctx: UiHttpContext): Promise<unknown> {
    const limit = clampLimit(readNumber(ctx.request, 'limit') ?? 10, 50);
    const type = readString(ctx.request, 'type');
    const [count, topFamilies, topTags] = await Promise.all([
      this.service.count(),
      type !== undefined ? this.service.topFamilies(limit, type) : this.service.topFamilies(limit),
      this.service.topTags(limit),
    ]);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: { count, topFamilies, topTags } });
  }

  /**
   * `GET <path>/api/metrics/stats?type=&windowMs=&buckets=` — per-type analytics
   * (latency percentiles, family/cache/status/exception breakdowns, throughput).
   */
  async metricsStats(ctx: UiHttpContext): Promise<unknown> {
    const type = readString(ctx.request, 'type');
    if (type === undefined) {
      return ctx.response.status(400).send({ error: '`type` query parameter is required' });
    }
    const windowMs = readNumber(ctx.request, 'windowMs') ?? 3_600_000;
    const buckets = readNumber(ctx.request, 'buckets');
    try {
      const data = await this.metrics.getStats({
        type,
        windowMs,
        ...(buckets !== undefined ? { buckets } : {}),
      });
      return ctx.response.status(200).header('content-type', 'application/json').send({ data });
    } catch (err) {
      return ctx.response.status(400).send({ error: asMessage(err) });
    }
  }

  /**
   * `GET <path>/api/metrics/timeseries?windowMs=&buckets=&type=` — throughput
   * over time (total + per-type per bucket).
   */
  async metricsTimeseries(ctx: UiHttpContext): Promise<unknown> {
    const windowMs = readNumber(ctx.request, 'windowMs') ?? 3_600_000;
    const buckets = readNumber(ctx.request, 'buckets');
    const type = readString(ctx.request, 'type');
    try {
      const data = await this.metrics.getTimeseries({
        windowMs,
        ...(buckets !== undefined ? { buckets } : {}),
        ...(type !== undefined ? { type } : {}),
      });
      return ctx.response.status(200).header('content-type', 'application/json').send({ data });
    } catch (err) {
      return ctx.response.status(400).send({ error: asMessage(err) });
    }
  }

  /** `GET <path>/api/metrics/traces?limit=` — recent traces, newest-last-seen first. */
  async metricsTraces(ctx: UiHttpContext): Promise<unknown> {
    const limit = clampLimit(readNumber(ctx.request, 'limit') ?? 50);
    const data = await this.metrics.getTraces(limit);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data, meta: { count: data.length } });
  }

  /** `GET <path>/api/metrics/waterfall/:traceId` — span waterfall for one trace, or 404. */
  async metricsWaterfall(ctx: UiHttpContext, traceId: string): Promise<unknown> {
    const data = await this.metrics.getWaterfall(traceId);
    if (data === null) {
      return ctx.response.status(404).send({ error: 'Trace not found' });
    }
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data, meta: { traceId } });
  }

  /**
   * `GET <path>/api/metrics/n-plus-one/:traceId?threshold=` — N+1 query-loop
   * patterns within a trace (loop attribution + wasted-time ranking).
   */
  async metricsNPlusOne(ctx: UiHttpContext, traceId: string): Promise<unknown> {
    const threshold = readNumber(ctx.request, 'threshold');
    const data = await this.metrics.getNPlusOne(traceId, threshold);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data, meta: { traceId, count: data.length } });
  }

  // — request replay (additive: kept in its own region for trivial merges) —
  /**
   * `POST <path>/api/requests/:id/replay` — re-issue a captured `request` entry
   * against the LOCAL server and report the outcome.
   *
   * This is a MUTATION (it actually hits the app, which may write), so it is
   * DISABLED BY DEFAULT: when `replay.enabled` is false the endpoint answers
   * `403` and never issues a call — mirroring the NestJS original's default-deny
   * mutation gate. `404` when there is no `request` entry with that id. The full
   * safety posture (same-origin only, credential stripping, bounded) lives in
   * `src/ui/request_replay.ts`.
   *
   * `requestPort` is the live dashboard request's local port (the provider reads it
   * off the incoming socket). It lets the replay target the same server the
   * dashboard is served from when the host hasn't pinned `replay.port`.
   */
  async replayRequest(ctx: UiHttpContext, id: string, requestPort?: number): Promise<unknown> {
    if (!this.replay.enabled) {
      return ctx.response
        .status(403)
        .send({ error: 'Request replay is disabled (set telescope_ui `replay.enabled: true`).' });
    }
    const entry = await this.service.find(id);
    if (entry === null || entry.type !== EntryType.Request) {
      return ctx.response.status(404).send({ error: 'No request entry with that id.' });
    }
    const { enabled: _enabled, ...replayOptions } = this.replay;
    const result: ReplayResult = await replayRequest(entry.content as RequestEntryContent, {
      ...replayOptions,
      ...(requestPort !== undefined ? { requestPort } : {}),
    });
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: result });
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A trimmed projection of an {@link Entry} for the list views — drops the
 * potentially-large `content` (the detail endpoint serves that) and derives a
 * short, human-readable `summary` line.
 */
export interface EntrySummary {
  id: string;
  type: string;
  familyHash: string | null;
  tags: string[];
  traceId: string | null;
  durationMs: number | null;
  sequence: number;
  createdAt: string;
  summary: string;
}

/** Project an entry to its {@link EntrySummary}. */
export function toSummary(entry: Entry): EntrySummary {
  return {
    id: entry.id,
    type: entry.type,
    familyHash: entry.familyHash,
    tags: entry.tags,
    traceId: entry.traceId,
    durationMs: entry.durationMs,
    sequence: entry.sequence,
    createdAt:
      entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
    summary: summarize(entry),
  };
}

/** Build a short one-line description suited to a list row. */
function summarize(entry: Entry): string {
  const content = entry.content as Record<string, unknown> | null | undefined;
  if (content && typeof content === 'object') {
    const method = typeof content.method === 'string' ? content.method : undefined;
    const url = typeof content.url === 'string' ? content.url : undefined;
    if (method && url) {
      const status = typeof content.status === 'number' ? ` → ${content.status}` : '';
      return `${method} ${url}${status}`;
    }
    const event = typeof content.event === 'string' ? content.event : undefined;
    const lib = typeof content.lib === 'string' ? content.lib : undefined;
    if (event) return lib ? `${lib}:${event}` : event;
    const message = typeof content.message === 'string' ? content.message : undefined;
    if (message) return message;
  }
  return entry.familyHash ?? entry.type;
}

/** Build an {@link EntryQuery} from the request's query string. */
export function buildQuery(request: UiRequest): EntryQuery {
  const query: EntryQuery = { limit: clampLimit(readNumber(request, 'limit') ?? DEFAULT_LIMIT) };
  const type = readString(request, 'type');
  if (type !== undefined) query.type = type;
  const tag = readString(request, 'tag');
  if (tag !== undefined) query.tag = tag;
  const traceId = readString(request, 'traceId');
  if (traceId !== undefined) query.traceId = traceId;
  const search = readString(request, 'search');
  if (search !== undefined) query.search = search;
  const before = readString(request, 'before');
  if (before !== undefined) {
    const date = new Date(before);
    if (!Number.isNaN(date.getTime())) query.before = date;
  }
  return query;
}

/** A JSON-safe echo of the applied query (Dates → ISO strings) for `meta`. */
function describe(query: EntryQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function clampLimit(value: number, max: number = MAX_LIMIT): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), max);
}

function readString(request: UiRequest, key: string): string | undefined {
  const value = request.qs()[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNumber(request: UiRequest, key: string): number | undefined {
  const value = request.qs()[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
