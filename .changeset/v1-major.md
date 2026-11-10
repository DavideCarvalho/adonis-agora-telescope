---
"@adonis-agora/telescope": major
"@adonis-agora/telescope-ui": major
---

1.0: the 0.x leftovers are removed.

Breaking changes in `@adonis-agora/telescope` (0.27 → 1.0):

- The version line moves from `0.x` to `1.x`. A range such as `^0.27.1` does not match `1.0.0`, so update it to `^1.0.0`.
- Node.js 24 or newer is required (`engines.node: ">=24"`).
- `storage.memory({ limit })` is removed. Use `storage.memory({ maxEntries })`, which takes the same number. `MemoryStoreConfig` is now the same type as `InMemoryStoreOptions`.
- `AiCoverage.legacyAgentLib` is removed from the AI metrics summary (`GET <path>/api/metrics/ai`, `MetricsService.getAi`, `summarizeAiUsage`). It flagged `@adonis-agora/agent` releases older than 0.93.0. `getAi` no longer runs the extra `lib:agent` probe when a window has no `usage.recorded`.

Breaking changes in `@adonis-agora/telescope-ui` (2.x → 3.0):

- The SPA no longer reads `window.__TELESCOPE_DASHBOARD_BASE__`. It takes the API base from the `telescope-dashboard-config` JSON data block the provider injects, or derives `<mount>/api` from the page URL. To point a hand-embedded client at another base, pass `new TelescopeClient({ baseUrl })`. `resolveApiBase(win, doc)` no longer accepts the global on `win`.
- `AiCoverage.legacyAgentLib` is removed from the `/client` types, and the AI screen's "Not measured" notice for agent releases older than 0.93.0 is gone.
- The `@adonis-agora/telescope` peer range is now `>=0.11.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0`, so the dashboard installs next to telescope 1.x, release candidates included.

See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/telescope/reference/migrating-to-1-0).
