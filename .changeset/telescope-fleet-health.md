---
'@adonis-agora/telescope': minor
---

Health checks and the fleet.

`checks` in `config/telescope.ts` runs `checks.redis()` (`PING`, a short write so a Redis at `maxmemory` that refuses writes is down, and a warning near `maxmemory`), `checks.lucid()` (`SELECT 1`), `checks.custom(name, run)` and any `@adonisjs/core/health` check. Each result is reused for its `cacheFor` (default 30 s) and concurrent callers share one run. `health: { readiness, liveness }` adds unauthenticated probe routes: readiness answers 503 while a critical check is down or the instance is draining; liveness never runs the checks. The console API serves the checks at `GET <path>/api/health`.

Every instance now sends a heartbeat every 15 s (`fleet` in `config/telescope.ts`, `fleet: false` turns it off): host, version (a git sha from the usual env vars, else the package.json version), boot time, state (`starting`, `ready`, `draining` on shutdown), its checks and, on a tenant, its send buffer. A tenant sends it with its batches over its transport; the control plane names the app from the token. The control plane, or a standalone app for its own replicas, keeps the instances (a `telescope_instances` table next to a Lucid store, in its `schema`, or memory; `configure` publishes the migration) and derives up / starting / draining / gone, deploys with rollout progress, restart loops and failing checks. `GET <path>/api/fleet` serves it to the console, scoped like every other read; `node ace telescope:fleet:list` and the `telescope_get_fleet` MCP tool answer the same.

New alert rules over the fleet, raising and resolving per app: `instances-up` (fewer than `below` up, including none), `restart-loop`, `check-down` (a check down for `for`) and `entries-dropped`.
