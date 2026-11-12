/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '1.0.0-rc.6';

export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from '../ui/console_authorize.js';
// — the access contract (shared with the console) —
export { authorizeByToken } from '../ui/console_authorize.js';
export type {
  McpToolName,
  ResolvedTelescopeMcpConfig,
  ResolveMcpConfigOptions,
  TelescopeMcpConfig,
} from './define_config.js';
// — config —
export {
  defineConfig,
  MCP_TOOL_NAMES,
  MISSING_MCP_AUTHORIZE_WARNING,
  resolveConfig,
} from './define_config.js';
export type {
  DiagnoseExceptionHook,
  JsonRpcRequest,
  McpToolSpec,
  TelescopeMcpServerOptions,
} from './server.js';
// — server (plain, testable JSON-RPC surface) —
export {
  MCP_INTERNAL_ERROR,
  MCP_METHOD_NOT_FOUND,
  MCP_TOOLS,
  MCP_UNAUTHORIZED,
  TelescopeMcpServer,
} from './server.js';
