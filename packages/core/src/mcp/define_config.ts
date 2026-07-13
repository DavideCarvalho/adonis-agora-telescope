import {
  type AuthorizeHook,
  type UiCredentials,
  defaultAuthorize,
  normalizePath,
} from '../ui/define_config.js';

/** The tools the MCP server can expose, in catalogue order. */
export const MCP_TOOL_NAMES = [
  'list_entries',
  'get_entry',
  'get_trace',
  'get_waterfall',
  'get_health',
  'diagnose_exception',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * The shape of `config/telescope_mcp.ts`. The MCP endpoint is a JSON-RPC transport
 * mounted at `path` (default `/telescope/mcp`) that lets a coding agent query the
 * captured telemetry over the Model Context Protocol.
 *
 * Access reuses the SAME guard as the dashboard/metrics API (`AuthorizeHook` +
 * `UiCredentials`): allowed automatically outside production, and in production only
 * when a `token`/`basic` credential — or a custom `authorize` hook — permits it. A
 * denial is surfaced as a JSON-RPC `-32001` error (MCP has no transport 401) so a
 * compliant client can read it.
 */
export interface TelescopeMcpConfig {
  /** Master switch. When `false`, the provider registers no routes at all. Default `true`. */
  enabled?: boolean;
  /** URL the JSON-RPC endpoint mounts at. Default `/telescope/mcp`. */
  path?: string;
  /**
   * The access-decision hook, identical to the UI/metrics guard. When omitted the
   * default policy is used: allow outside production, otherwise require a configured
   * {@link UiCredentials}. Delegate to your own app auth here.
   */
  authorize?: AuthorizeHook;
  /** Built-in credentials for the default policy (ignored when `authorize` is set). */
  credentials?: UiCredentials;
  /**
   * Which tools to expose. Omit for all six. Restrict this to hand an agent a
   * narrower surface (e.g. read-only `['list_entries', 'get_trace', 'get_health']`).
   */
  tools?: McpToolName[];
}

/** The fully-resolved MCP config the provider acts on. */
export interface ResolvedTelescopeMcpConfig {
  enabled: boolean;
  /** Always a leading-slash, no-trailing-slash path, e.g. `/telescope/mcp`. */
  path: string;
  authorize: AuthorizeHook;
  credentials: UiCredentials;
  /** The enabled tool set. */
  tools: ReadonlySet<McpToolName>;
}

/**
 * Identity helper giving `config/telescope_mcp.ts` full type-checking. Mirrors the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope/mcp'
 * export default defineConfig({ path: '/__telescope/mcp' })
 * ```
 */
export function defineConfig(config: TelescopeMcpConfig): TelescopeMcpConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeMcpConfig = {}): ResolvedTelescopeMcpConfig {
  const credentials = config.credentials ?? {};
  const tools = config.tools !== undefined ? config.tools : MCP_TOOL_NAMES;
  return {
    enabled: config.enabled ?? true,
    path: normalizePath(config.path ?? '/telescope/mcp'),
    authorize: config.authorize ?? defaultAuthorize(credentials),
    credentials,
    tools: new Set<McpToolName>(tools),
  };
}
