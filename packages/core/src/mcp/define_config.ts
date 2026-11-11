import { type ConsoleAuthorize, resolveConsoleAuthorize } from '../ui/console_authorize.js';
import { type AuthorizeHook, normalizePath } from '../ui/define_config.js';

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
 * Access: `authorize`, the same {@link ConsoleAuthorize} contract as the console. MCP clients
 * send a Bearer token, so the usual choice is `authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') })`.
 * When omitted, the endpoint is open outside production and answers `403` in production.
 * A denial is JSON: `403 { error: 'forbidden' }` or `401 { error: 'unauthenticated' }`.
 */
export interface TelescopeMcpConfig {
  /** Master switch. When `false`, the provider registers no routes at all. Default `true`. */
  enabled?: boolean;
  /** URL the JSON-RPC endpoint mounts at. Default `/telescope/mcp`. */
  path?: string;
  /**
   * Who may call the endpoint, in any {@link ConsoleAuthorize} form (a function, an authorizer
   * class, or a lazy import of one). For MCP clients sending `Authorization: Bearer <token>`:
   * `authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') })`.
   *
   * When omitted, the endpoint is open outside production and answers `403` to every request in
   * production (with one warning at boot).
   */
  authorize?: ConsoleAuthorize;
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
  /** Whether the host configured `authorize` (when not, the production default denies everything). */
  authorizeConfigured: boolean;
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

/** Whether the current process is running in production (used when the caller does not say). */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Options for {@link resolveConfig}. */
export interface ResolveMcpConfigOptions {
  /** Whether the app runs in production (`app.inProduction`). Defaults to `NODE_ENV === 'production'`. */
  inProduction?: boolean;
}

/**
 * The warning logged once at boot when `authorize` is omitted.
 *
 * @internal Used by the MCP provider.
 */
export const MISSING_MCP_AUTHORIZE_WARNING =
  '[@adonis-agora/telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/telescope_mcp.ts.';

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(
  config: TelescopeMcpConfig = {},
  options: ResolveMcpConfigOptions = {},
): ResolvedTelescopeMcpConfig {
  const inProduction = options.inProduction ?? isProduction();
  const tools = config.tools !== undefined ? config.tools : MCP_TOOL_NAMES;
  return {
    enabled: config.enabled ?? true,
    path: normalizePath(config.path ?? '/telescope/mcp'),
    authorize:
      config.authorize === undefined
        ? () => !inProduction
        : resolveConsoleAuthorize(config.authorize),
    authorizeConfigured: config.authorize !== undefined,
    tools: new Set<McpToolName>(tools),
  };
}
