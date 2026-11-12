---
"@adonis-agora/telescope": major
---

**Breaking: the standalone `/telescope/mcp` endpoint is opt-in.** `enabled` in `config/telescope_mcp.ts` now defaults to `false`: without `enabled: true` (or with no config file) the MCP provider mounts no route and logs no warning. Telescope's MCP tools are served on the Agora dev endpoint `/mcp/agora` (from `@adonis-agora/agent/mcp_provider`), behind the console's `authorize`, with authkit OAuth sign-in. With `enabled: true` the endpoint behaves as before.

`agora:doctor` follows: `telescope.mcp-gate` and `telescope.mcp-csrf` are skipped while the endpoint is off (the gate's message points to `/mcp/agora`). The `configure` prompt now offers it as "Standalone MCP endpoint", and the published `config/telescope_mcp.ts` sets `enabled: true`. New export `checkMcpGate` from `@adonis-agora/telescope/doctor`.

**Upgrade:** apps that use `/telescope/mcp`: set `enabled: true` in `config/telescope_mcp.ts`, or switch clients to `/mcp/agora`.

```ts
export default defineConfig({
  enabled: true,
  authorize: authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') }),
})
```
