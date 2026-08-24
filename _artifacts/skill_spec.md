# Skill spec — adonis-telescope

Autonomous compressed discovery. No maintainer interview was run (fully autonomous
constraint); everything below is grounded in README.md, DESIGN.md, docs/**
(concepts/, dashboard/, packages/, recipes/, reference/, getting-started.mdx) and
packages/{core,ui}/src. Versions read from packages/*/package.json:
`@adonis-agora/telescope` 0.8.4, `@adonis-agora/telescope-ui` 1.0.2.

## Scope decision

The repo publishes exactly two packages. Everything else is a **subpath of
`@adonis-agora/telescope`** (watchers, ui, ai, alerts, mcp, cpu_profiling — the
first-party AdonisJS convention, like `@adonisjs/auth`'s guards), so skills target
the two packages with the subpaths folded into five core skills. The AdonisJS
implementation differs from the NestJS sibling in load-bearing ways that the skills
must reflect: `node ace configure` codemods instead of module imports, a
config-file-per-subpath model (`config/telescope*.ts` + `defineConfig` per subpath)
instead of `forRoot` options, Lucid as the storage driver instead of a Redis
adapter, and the `TelescopeMiddleware` server-stack capture.

## Skill set (flat; all type `core`)

Core package — `packages/core/skills/`:
1. `telescope-setup` — `node ace configure`, `config/telescope.ts`
   (`defineConfig`, `storage.memory/lucid`), `TelescopeMiddleware` server stack,
   the headless `TelescopeService` API (`list`/`find`/`byTrace`/`topFamilies`/
   `topTags`/`getHealth`), `recordException`, `requestCapture`.
2. `telescope-watchers` — `config/telescope_watchers.ts` and the
   `@adonis-agora/telescope/watchers` subpath: the verified-by-default Lucid query
   watcher, mail/cache/http-client/logs/queue/events/redis watchers, user-driven
   `profile()`/`scheduleTask()` helpers, the custom `Watcher` contract +
   `safeRecord`, the `logs`-in-both-configs trap, the Lucid `debug` flag.
3. `telescope-storage-retention` — `storage.memory` vs `storage.lucid`, the
   `TelescopeStore` contract, `prune`/`overload` protection, `redact`, `sampling`,
   the `create_telescope_entries_table` migration, custom store rules
   (traceId/origin resolution, `contentText` for search).
4. `telescope-alerts-ai` — `config/telescope_alerts.ts` (rules incl.
   `every-exception` + stateful `metric-threshold`, channels, `cooldown`,
   `geoLookup`), `config/telescope_ai.ts` + `TelescopeAiDiagnoser` (keyless ⇒
   disabled), `clientErrors` ingestion + the `sendBeacon` reporter.
5. `telescope-access-mcp` — the `authorize`/`credentials`/`dashboardAuth` guard
   (401-vs-403, redirect-wins, fail-closed boot), the mutation gates
   (`replay`, `queueActions`, `cpuProfiling.armEnabled`), and
   `config/telescope_mcp.ts` (JSON-RPC `-32001`, `tools` allow-list).

UI package — `packages/ui/skills/`:
6. `telescope-ui-dashboard` — `@adonis-agora/telescope-ui/telescope_ui_dashboard_provider`
   registered AFTER `ui_provider`, the ten-section SPA, `TelescopeClient` from
   `/client`, `/api/meta` capability discovery, the `{ ok: false }` mutation
   results, client-side exports, format helpers.

## Highest-value AI-agent guidance (what to get right)

- Provider order: `telescope_ui_dashboard_provider` must be registered **after**
  `ui_provider`; the SPA has no backend otherwise. And without the SPA package at
  all, `/telescope` is a 404 — the core is genuinely headless.
- Lucid `db:query` only flows when the connection `debug` flag is on (or a
  listener exists at report time). A query watcher that "runs but records nothing"
  is almost always this.
- `logs` appears in BOTH config files; whichever provider boots first owns the
  logger tap, the other warns and stays inert (its options silently ignored).
- The default dashboard policy denies production until a `credential` or
  `authorize` hook permits it; an `authorize` hook REPLACES the credentials gate,
  while `dashboardAuth` composes WITH `authorize`.
- Alerts: only the FIRST rule of each exception type is evaluated; sampled-out
  exceptions never reach a rule; a keyless AI config is disabled, not broken.
- Storage: the memory driver is per-process and lost on restart; the lucid driver
  never auto-prunes — arm `prune` or the table grows forever.
- Custom stores must resolve `traceId`/`origin` in `record` or correlation breaks
  silently; `search` needs a flattened `contentText` column.

## Remaining Gaps (interview substitutes)

- Priority ordering among the optional subpaths (mcp / cpu_profiling /
  client-errors) for any future dedicated skills is unknown.
- No GitHub issue mining was performed this session; failure modes are sourced
  from the unusually detailed docs callouts and source comments rather than from
  issue reports, so real-world frequency is unconfirmed.
- Whether teams commonly hand-roll provider wiring (skipping the `node ace
  configure` codemods) is assumed from the providers table, not telemetry.
- The `dashboard.path` SPA-mount override is documented but left out of Common
  Mistakes for lack of evidence that it trips people up.

## Recommended Skill File Structure

- **Core skills:** all six skills are framework-agnostic in the AdonisJS sense —
  they document server-side AdonisJS configuration, not React (the SPA skill
  documents mounting/consuming, not component authoring).
- **Framework skills:** none — there are no framework adapters; the UI package
  ships a pre-built SPA plus a dependency-free client.
- **Lifecycle skills:** none — setup is one configure command; a separate
  quickstart skill would duplicate `telescope-setup`.
- **Composition skills:** none shipped. `@adonis-agora/context` (trace
  correlation) and `@adonis-agora/diagnostics` (the diagnostics spine) are read
  structurally via global `Symbol.for` slots and are covered inside
  `telescope-setup`/`telescope-watchers`; they are separate repos, not peers.
- **Reference files:** none needed — every skill stays well under the 500-line
  budget; per-watcher option tables live in the watchers skill.

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| `@adonis-agora/context` | `currentTraceId()`, `userRef()`/`tenantId()` tags, trace correlation | no — structural slot, covered in setup/watchers skills |
| `@adonis-agora/diagnostics` | `agora:<lib>:<event>` channels → `diagnostic` entries | no — one generic watcher, covered in setup/watchers skills |
| `@adonisjs/lucid` | `db:query` events + the `lucid` storage driver (optional peer) | no — core of the watchers and storage skills |
| `@adonisjs/queue` / `@adonisjs/redis` | diagnostics-channel / sendCommand taps (not declared peers) | no — covered in the watchers skill |
| `@anthropic-ai/sdk` | Claude Messages API for diagnosis (optional peer) | no — covered in the alerts-ai skill |
