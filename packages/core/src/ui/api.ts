import type { Entry } from '../entry.js';
import type { TelescopeService } from '../service.js';
import type { EntryQuery } from '../store.js';
import type { UiHttpContext, UiRequest } from './http.js';

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
  constructor(private readonly service: TelescopeService) {}

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
