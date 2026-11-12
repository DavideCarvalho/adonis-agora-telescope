---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Organizations (tenancy). With `tenancy.enabled` in `config/context.ts`, every entry is tagged with the active organization (`tenant:<id>`, one tag per level of a nested tenant, `tenant:*` inside `Context.allTenants()`), and the console, JSON API, live tail, `/telescope/mcp` and the dev MCP tools show each viewer only the organizations its `authorize` grants: its own by default, or `{ allowed: true, tenants: [...] | '*' }`. Counts and groups are computed from those entries only. The console header gains an Organization picker (`?tenant=<id>`), and `authorizeByToken` takes `tenants`. New options: `tenancy: 'inherit' | false | { kinds, tag }` in `config/telescope.ts`; `EntryQuery.anyTags` on every store. Viewers limited to some organizations cannot run actions that reach all of them (CPU capture, queue actions, extension actions, Prometheus).
