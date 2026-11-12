---
'@adonis-agora/telescope': minor
---

Telescope's MCP tools are served on the Agora dev endpoint (`/mcp/agora`, from `@adonis-agora/agent/mcp_provider`) with no config: `telescope_list_entries` (paged, `{ items, next }`), `telescope_get_entry`, `telescope_get_trace`, `telescope_get_waterfall`, `telescope_get_health` and `telescope_diagnose_exception` (listed only with AI diagnosis), gated by the console's `authorize` from `config/telescope_ui.ts`. `/telescope/mcp` is unchanged. `TelescopeMcpServer` gains `call(name, args)`, `listEntries(args)` and `canDiagnose()`.
