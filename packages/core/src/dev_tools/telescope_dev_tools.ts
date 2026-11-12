import type { TelescopeMcpServer } from '../mcp/server.js';
import type { AuthorizeHook } from '../ui/define_config.js';
import { runGuard } from '../ui/guard.js';
import type { UiHttpContext } from '../ui/http.js';
import {
  DEV_TOOLS_BINDING,
  type DevTool,
  type DevToolsDecision,
  type DevToolsHub,
  type DevToolsLib,
} from './contract.js';

const LIMIT = {
  type: 'integer',
  description: 'Max entries (default 20, max 100)',
  minimum: 1,
  maximum: 100,
} as const;

/**
 * Telescope's developer tools for the dev MCP endpoint: the same six tools as `/telescope/mcp`,
 * prefixed `telescope_`, answered by the same {@link TelescopeMcpServer} over stored (already
 * redacted) entries.
 */
export function telescopeDevTools(server: TelescopeMcpServer): DevTool[] {
  return [
    {
      name: 'telescope_list_entries',
      kind: 'read',
      description:
        'List recent telescope entries (requests, queries, exceptions, diagnostics, jobs, logs…), newest first, as compact summaries. Filter by type, search, tag or window. Returns { items, next } where next is the next page number or null.',
      input: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description:
              'Entry type: request, query, exception, client_exception, log, event, mail, job, cache, http-client, redis, diagnostic…',
          },
          search: { type: 'string', description: 'Case-insensitive substring over content + tags' },
          tag: { type: 'string', description: 'Exact tag, e.g. "status:500" or "lib:billing"' },
          sinceMinutes: {
            type: 'number',
            description: 'Only entries from the last N minutes',
            minimum: 0,
          },
          limit: LIMIT,
          page: { type: 'integer', description: '1-based page (default 1)', minimum: 1 },
        },
      },
      run: async (input, call) =>
        server.listEntries({
          ...input,
          limit: Math.min(numberOr(input.limit, 20), call.limits.maxRows),
        }),
    },
    {
      name: 'telescope_get_entry',
      kind: 'read',
      description:
        'Get one entry by id with the other entries of its trace (summaries). Returns { entry, trace } or { notice } when it was pruned.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Entry id' } },
        required: ['id'],
      },
      run: async (input) => server.call('get_entry', input),
    },
    {
      name: 'telescope_get_trace',
      kind: 'read',
      description:
        'Every entry recorded under one trace id (one request or job), newest first. Returns { entries } or { notice }.',
      input: {
        type: 'object',
        properties: { traceId: { type: 'string', description: 'Trace id' } },
        required: ['traceId'],
      },
      run: async (input) => server.call('get_trace', input),
    },
    {
      name: 'telescope_get_waterfall',
      kind: 'read',
      description:
        'The span waterfall of one trace: each operation as a start/duration span, in order. Returns the waterfall or { notice }.',
      input: {
        type: 'object',
        properties: { traceId: { type: 'string', description: 'Trace id' } },
        required: ['traceId'],
      },
      run: async (input) => server.call('get_waterfall', input),
    },
    {
      name: 'telescope_get_health',
      kind: 'read',
      description:
        'Pulse health over a trailing window (default 60 minutes): throughput, latency percentiles, slowest requests and queries, hotspots, N+1 suspects, top exception families, cache hit rate.',
      input: {
        type: 'object',
        properties: {
          sinceMinutes: {
            type: 'number',
            description: 'Window in minutes (default 60)',
            minimum: 1,
          },
        },
      },
      run: async (input) => server.call('get_health', input),
    },
    {
      name: 'telescope_diagnose_exception',
      kind: 'read',
      description:
        'AI diagnosis of an exception entry (probable cause, where to look, a fix), as markdown. Spends AI tokens.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Exception entry id' } },
        required: ['id'],
      },
      available: () => server.canDiagnose(),
      run: async (input) => server.call('diagnose_exception', input),
    },
  ];
}

/** Map telescope's console gate onto the dev-tools decision. Never throws. */
export function devToolsGate(authorize: AuthorizeHook): DevToolsLib['authorize'] {
  return async (ctx): Promise<DevToolsDecision> => {
    try {
      const result = await runGuard(ctx as UiHttpContext, authorize);
      if (result.allowed) return { allowed: true };
      return {
        allowed: false,
        reason: result.message === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
        ...(result.redirectTo !== undefined ? { redirectTo: result.redirectTo } : {}),
      };
    } catch {
      return { allowed: false, reason: 'forbidden' };
    }
  };
}

/** The slice of the AdonisJS container registration needs (structural). */
export interface DevToolsContainerLike {
  hasBinding(key: string): boolean;
  make(key: string): Promise<unknown>;
}

/**
 * Register telescope's tools into the `'agora.devTools'` hub when the app runs the agent's MCP
 * provider. Returns whether it registered. Never throws: an unknown hub version or a hub that
 * refuses the registration is skipped (`onSkip` explains why).
 */
export async function registerTelescopeDevTools(
  container: DevToolsContainerLike,
  server: TelescopeMcpServer,
  authorize: AuthorizeHook,
  onSkip: (reason: string) => void = () => {},
): Promise<boolean> {
  try {
    if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
    const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
    if (hub === undefined || hub === null || typeof hub.register !== 'function') {
      onSkip(`'${DEV_TOOLS_BINDING}' is bound to something that is not a dev tools hub`);
      return false;
    }
    if (hub.version !== 1) {
      onSkip(`dev tools hub version ${String(hub.version)} is not supported`);
      return false;
    }
    hub.register({
      lib: 'telescope',
      title: 'Telescope',
      authorize: devToolsGate(authorize),
      tools: telescopeDevTools(server),
    });
    return true;
  } catch (err) {
    onSkip(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
