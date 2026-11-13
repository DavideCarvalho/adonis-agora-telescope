---
"@adonis-agora/telescope": major
---

**Breaking: the standalone `/telescope/mcp` endpoint is removed.** Telescope's MCP tools are served only on the Agora dev endpoint `/mcp/agora` (from `@adonis-agora/agent/mcp_provider`), behind the console's `authorize`. Gone: the `@adonis-agora/telescope/mcp` and `@adonis-agora/telescope/mcp_provider` subpaths, `config/telescope_mcp.ts` and its stub, the **Standalone MCP endpoint** `configure` option, the `telescope.mcp-gate` and `telescope.mcp-csrf` doctor checks (and `checkMcpGate`), and the root exports `TelescopeMcpServer`, `MCP_TOOLS`, `MCP_TOOL_NAMES`, `MCP_UNAUTHORIZED`, `MCP_METHOD_NOT_FOUND`, `MCP_INTERNAL_ERROR` and the `McpToolName`, `McpToolSpec`, `JsonRpcRequest`, `DiagnoseExceptionHook`, `TelescopeMcpConfig`, `ResolvedTelescopeMcpConfig`, `TelescopeMcpServerOptions` types.

**Upgrade:** remove `@adonis-agora/telescope/mcp_provider` from `adonisrc.ts`, delete `config/telescope_mcp.ts`, drop `TELESCOPE_MCP_TOKEN` from `start/env.ts`, and drop `/telescope/mcp` from `csrf.exceptRoutes`. Point MCP clients at `/mcp/agora`; `authorizeByToken` comes from `@adonis-agora/telescope/ui`. See "Migrating to 1.0".
