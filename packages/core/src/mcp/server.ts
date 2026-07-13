import { EntryType, type Entry } from '../entry.js';
import type { MetricsService } from '../metrics/metrics_service.js';
import type { TelescopeService } from '../service.js';
import type { EntryQuery } from '../store.js';
import { MCP_TOOL_NAMES, type McpToolName } from './define_config.js';

/** The MCP protocol revision this server advertises when a client omits its own. */
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_HEALTH_WINDOW_MS = 60 * 60_000;

/** JSON-RPC error code for an unauthorized request (there is no transport 401 in MCP). */
export const MCP_UNAUTHORIZED = -32001;
/** JSON-RPC "method not found". */
export const MCP_METHOD_NOT_FOUND = -32601;
/** JSON-RPC "internal error" — a tool handler threw. */
export const MCP_INTERNAL_ERROR = -32603;

/** One entry in the MCP tool catalogue (name + human description + JSON-Schema for args). */
export interface McpToolSpec {
  name: McpToolName;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/**
 * The full tool catalogue. `tools/list` returns the subset the config enables;
 * `tools/call` dispatches on `name`. Keep the descriptions agent-facing — they are
 * what a coding agent (Claude Code, Cursor, …) reads to decide which tool to call.
 */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'list_entries',
    description:
      'List recent telescope entries (requests, queries, exceptions, diagnostics, jobs, logs, …). Filter by type, full-text search, tag, or time window. Returns newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Entry type: request, query, exception, client_exception, log, event, mail, job, cache, http-client, redis, diagnostic…',
        },
        search: { type: 'string', description: 'Case-insensitive substring over entry content + tags' },
        tag: { type: 'string', description: 'Exact tag match, e.g. "status:500" or "lib:billing"' },
        sinceMinutes: { type: 'number', description: 'Only entries from the last N minutes' },
        limit: { type: 'number', description: 'Max entries (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_entry',
    description:
      'Get one entry by id, together with the other entries recorded in the same trace (its siblings) — the request/job waterfall context.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_trace',
    description:
      'Get every entry recorded under one trace id (one request/job execution), newest-first — queries, logs, diagnostics, the request itself.',
    inputSchema: {
      type: 'object',
      properties: { traceId: { type: 'string', description: 'Trace id' } },
      required: ['traceId'],
    },
  },
  {
    name: 'get_waterfall',
    description:
      'Get the span waterfall for one trace: each recorded operation as a start/duration span, ordered, so you can see what ran (and how long) inside a request.',
    inputSchema: {
      type: 'object',
      properties: { traceId: { type: 'string', description: 'Trace id' } },
      required: ['traceId'],
    },
  },
  {
    name: 'get_health',
    description:
      'Aggregate Pulse health snapshot over a trailing window (default 1h): request throughput + latency percentiles, slowest requests/queries, slow-route/outgoing/job hotspots, N+1 suspects, top exception families, cache hit rate, load-by-user.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceMinutes: { type: 'number', description: 'Trailing window in minutes (default 60)' },
      },
    },
  },
  {
    name: 'diagnose_exception',
    description:
      'Run the AI diagnosis on an exception entry (probable cause, where to look, suggested fix). Only available when AI diagnosis is configured on this telescope.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Exception entry id' } },
      required: ['id'],
    },
  },
];

/** A parsed JSON-RPC request body (all fields optional so a malformed body is handled, not thrown). */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface ToolArgs {
  type?: string;
  search?: string;
  tag?: string;
  sinceMinutes?: number;
  limit?: number;
  id?: string;
  traceId?: string;
}

/** Optional AI diagnosis hook — resolves the diagnosis markdown, or `null` when AI is off. */
export type DiagnoseExceptionHook = (entry: Entry) => Promise<string | null> | string | null;

/** Construction deps for {@link TelescopeMcpServer}. */
export interface TelescopeMcpServerOptions {
  /** Which tools this server exposes. Omit for all. */
  tools?: ReadonlySet<McpToolName>;
  /** `serverInfo` reported on `initialize`. */
  serverInfo?: { name: string; version: string };
  /**
   * AI diagnosis hook backing `diagnose_exception`. When omitted, the tool reports
   * that AI diagnosis is not configured (rather than failing), mirroring the
   * default-open dashboard posture.
   */
  diagnose?: DiagnoseExceptionHook;
}

/**
 * MCP (Model Context Protocol) server — a stateless JSON-RPC surface — so a coding
 * agent can query the app's captured telemetry: "why is POST /checkout slow?" → the
 * agent lists slow requests, pulls the trace waterfall, reads the queries.
 *
 * Hand-rolled JSON-RPC (no SDK dependency), backed by the SAME
 * {@link TelescopeService} / {@link MetricsService} / Pulse APIs the dashboard uses,
 * so analysis reads already-redacted, already-sampled stored entries — redaction is
 * never bypassed. Idiomatic Adonis: a plain, testable class with no framework
 * coupling; the provider owns the HTTP transport and the auth guard, and hands this
 * server a pre-computed `authorized` flag per call.
 */
export class TelescopeMcpServer {
  private readonly tools: ReadonlySet<McpToolName>;
  private readonly serverInfo: { name: string; version: string };
  private readonly diagnose: DiagnoseExceptionHook | undefined;

  constructor(
    private readonly service: TelescopeService,
    private readonly metrics: MetricsService,
    options: TelescopeMcpServerOptions = {},
  ) {
    this.tools = options.tools ?? new Set(MCP_TOOL_NAMES);
    this.serverInfo = options.serverInfo ?? { name: 'adonis-telescope', version: '0.0.0' };
    this.diagnose = options.diagnose;
  }

  /** The enabled tool catalogue (what `tools/list` returns), in declaration order. */
  toolCatalogue(): McpToolSpec[] {
    return MCP_TOOLS.filter((tool) => this.tools.has(tool.name));
  }

  /**
   * Handle one JSON-RPC request. `authorized` is the outcome of the transport's
   * auth guard: when `false`, every method is refused with a JSON-RPC `-32001`
   * error (MCP has no transport-level 401, so the denial rides inside the RPC
   * envelope where a compliant client can read it). Notifications (no `id`) resolve
   * to `null` — the caller answers `202` with no body.
   */
  async handle(body: JsonRpcRequest, authorized: boolean): Promise<unknown> {
    const { id, method, params } = body ?? {};
    if (!authorized) {
      return this.fail(id, MCP_UNAUTHORIZED, 'Unauthorized: telescope MCP access was denied.');
    }
    try {
      switch (method) {
        case 'initialize':
          return this.respond(id, {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return this.respond(id, {});
        case 'tools/list':
          return this.respond(id, { tools: this.toolCatalogue() });
        case 'tools/call': {
          const text = await this.callTool(params?.name, (params?.arguments ?? {}) as ToolArgs);
          return this.respond(id, { content: [{ type: 'text', text }] });
        }
        default:
          return this.fail(id, MCP_METHOD_NOT_FOUND, `Method not found: ${String(method)}`);
      }
    } catch (error: unknown) {
      return this.fail(id, MCP_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }

  private respond(id: JsonRpcRequest['id'], result: unknown): unknown {
    return id === undefined || id === null ? null : { jsonrpc: '2.0', id, result };
  }

  private fail(id: JsonRpcRequest['id'], code: number, message: string): unknown {
    return id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code, message } };
  }

  private async callTool(name: string | undefined, args: ToolArgs): Promise<string> {
    if (name !== undefined && !this.tools.has(name as McpToolName)) {
      throw new Error(`Tool not enabled: ${name}`);
    }
    switch (name) {
      case 'list_entries': {
        const query: EntryQuery = {
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.search !== undefined && args.search !== '' ? { search: args.search } : {}),
          ...(args.tag !== undefined ? { tag: args.tag } : {}),
          ...(typeof args.sinceMinutes === 'number'
            ? { after: new Date(Date.now() - args.sinceMinutes * 60_000) }
            : {}),
          limit: clampLimit(args.limit),
        };
        const entries = await this.service.list(query);
        return json({ entries: entries.map(slim) });
      }
      case 'get_entry': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        const entry = await this.service.find(args.id);
        if (entry === null) return 'Entry not found (it may have been pruned).';
        const siblings =
          entry.traceId !== null
            ? (await this.service.byTrace(entry.traceId)).filter((e) => e.id !== entry.id)
            : [];
        return json({ entry, trace: siblings.map(slim) });
      }
      case 'get_trace': {
        if (typeof args.traceId !== 'string') throw new Error('`traceId` is required.');
        const entries = await this.service.byTrace(args.traceId);
        if (entries.length === 0) return 'Trace not found (it may have been pruned).';
        return json({ entries });
      }
      case 'get_waterfall': {
        if (typeof args.traceId !== 'string') throw new Error('`traceId` is required.');
        const waterfall = await this.metrics.getWaterfall(args.traceId);
        if (waterfall === null) return 'Trace not found (it may have been pruned).';
        return json(waterfall);
      }
      case 'get_health': {
        const windowMs =
          typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0
            ? args.sinceMinutes * 60_000
            : DEFAULT_HEALTH_WINDOW_MS;
        const health = await this.service.getHealth({ windowMs });
        return json(health);
      }
      case 'diagnose_exception': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        if (this.diagnose === undefined) {
          return 'AI diagnosis is not configured on this telescope.';
        }
        const entry = await this.service.find(args.id);
        if (
          entry === null ||
          (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
        ) {
          return 'No exception entry with that id.';
        }
        const markdown = await this.diagnose(entry);
        return markdown ?? 'AI diagnosis returned no result.';
      }
      default:
        throw new Error(`Unknown tool: ${String(name)}`);
    }
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIST_LIMIT));
}

/** Compact projection for list payloads — agents drill in via `get_entry`/`get_trace`. */
function slim(entry: Entry): Record<string, unknown> {
  const c = (entry.content ?? {}) as Record<string, unknown>;
  let summary: string;
  switch (entry.type) {
    case EntryType.Request:
      summary = `${String(c.method)} ${String(c.url)} → ${String(c.status)}`;
      break;
    case EntryType.Query:
      summary = String(c.sql ?? '').slice(0, 200);
      break;
    case EntryType.Exception:
    case EntryType.ClientException:
      summary = `${String(c.name ?? c.class)}: ${String(c.message)}`;
      break;
    case EntryType.Log:
      summary = `${String(c.level)}: ${String(c.message)}`;
      break;
    case EntryType.Job:
      summary = `${String(c.name)} (${String(c.status)})`;
      break;
    default:
      summary = safeSummary(c, entry.type);
  }
  return {
    id: entry.id,
    type: entry.type,
    traceId: entry.traceId,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
    tags: entry.tags,
    summary,
  };
}

function safeSummary(content: Record<string, unknown>, type: string): string {
  try {
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return type;
  }
}
