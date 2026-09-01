/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.12.0';

export type {
  McpToolName,
  ResolvedTelescopeMcpConfig,
  TelescopeMcpConfig,
} from './define_config.js';
// — config —
export { defineConfig, MCP_TOOL_NAMES, resolveConfig } from './define_config.js';
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
