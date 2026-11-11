import { type AuthorizeHook, normalizePath } from '../ui/define_config.js';
import type { UiHttpContext } from '../ui/http.js';

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
 * Built-in credentials for the MCP endpoint's default policy, used when no `authorize` hook is
 * configured. A request is allowed in production only when it presents one of them.
 */
export interface McpCredentials {
  /**
   * A bearer/opaque token. A request is allowed when it carries
   * `Authorization: Bearer <token>` OR `?token=<token>` matching this value.
   */
  token?: string;
  /** HTTP Basic credentials (`Authorization: Basic <base64(user:pass)>`). */
  basic?: { username: string; password: string };
}

/**
 * The shape of `config/telescope_mcp.ts`. The MCP endpoint is a JSON-RPC transport
 * mounted at `path` (default `/telescope/mcp`) that lets a coding agent query the
 * captured telemetry over the Model Context Protocol.
 *
 * Access: allowed automatically outside production, and in production only when a
 * `token`/`basic` credential ({@link McpCredentials}) — or a custom `authorize` hook — permits it. A
 * denial is surfaced as a JSON-RPC `-32001` error (MCP has no transport 401) so a
 * compliant client can read it.
 */
export interface TelescopeMcpConfig {
  /** Master switch. When `false`, the provider registers no routes at all. Default `true`. */
  enabled?: boolean;
  /** URL the JSON-RPC endpoint mounts at. Default `/telescope/mcp`. */
  path?: string;
  /**
   * The access-decision hook. When omitted the default policy is used: allow outside
   * production, otherwise require a configured {@link McpCredentials}. Delegate to your own
   * app auth here.
   */
  authorize?: AuthorizeHook;
  /** Built-in credentials for the default policy (ignored when `authorize` is set). */
  credentials?: McpCredentials;
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
  credentials: McpCredentials;
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

/** Whether the current process is running in production. */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Constant-time-ish string compare, so a configured secret does not leak through `===` timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Pull a bearer token from `Authorization: Bearer …` or `?token=…`. */
function readToken(ctx: UiHttpContext): string | undefined {
  const auth = ctx.request.header('authorization');
  if (auth !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  const qsToken = ctx.request.qs().token;
  return typeof qsToken === 'string' ? qsToken : undefined;
}

/** Decode and compare `Authorization: Basic …` against configured credentials. */
function matchesBasic(ctx: UiHttpContext, basic: { username: string; password: string }): boolean {
  const auth = ctx.request.header('authorization');
  if (auth === undefined) return false;
  const match = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (match?.[1] === undefined) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  return (
    safeEqual(decoded.slice(0, sep), basic.username) &&
    safeEqual(decoded.slice(sep + 1), basic.password)
  );
}

/**
 * The MCP endpoint's default policy: a matching `token`/`basic` credential is allowed; otherwise
 * allowed only outside production. A denial is `'unauthenticated'` when no credential was
 * presented and `'forbidden'` when one was presented but rejected.
 */
function credentialsAuthorize(credentials: McpCredentials): AuthorizeHook {
  return (ctx) => {
    if (credentials.token !== undefined) {
      const presented = readToken(ctx);
      if (presented !== undefined && safeEqual(presented, credentials.token)) return true;
    }
    if (credentials.basic !== undefined && matchesBasic(ctx, credentials.basic)) return true;
    if (!isProduction()) return true;
    const presented =
      ctx.request.header('authorization') !== undefined ||
      typeof ctx.request.qs().token === 'string';
    return { allowed: false, reason: presented ? 'forbidden' : 'unauthenticated' };
  };
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeMcpConfig = {}): ResolvedTelescopeMcpConfig {
  const credentials = config.credentials ?? {};
  const tools = config.tools !== undefined ? config.tools : MCP_TOOL_NAMES;
  return {
    enabled: config.enabled ?? true,
    path: normalizePath(config.path ?? '/telescope/mcp'),
    authorize: config.authorize ?? credentialsAuthorize(credentials),
    credentials,
    tools: new Set<McpToolName>(tools),
  };
}
