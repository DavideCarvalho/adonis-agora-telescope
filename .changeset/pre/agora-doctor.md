---
'@adonis-agora/telescope': minor
---

`node ace agora:doctor` (and `telescope:doctor`): one health check for every installed `@adonis-agora` lib, the same command every lib ships. Telescope adds its checks: `telescope.console-gate`, `telescope.mcp-gate`, `telescope.mcp-csrf`, `telescope.client-errors-csrf`, `telescope.otel` (OpenTelemetry SDK 2 and SDK 3 mixed is an error; two copies of `@opentelemetry/api` warn) and `telescope.retention`. `configure` registers the new `@adonis-agora/telescope/commands` barrel; on an existing app add it to `adonisrc.ts` `commands`. New subpaths: `./commands`, `./doctor`.
