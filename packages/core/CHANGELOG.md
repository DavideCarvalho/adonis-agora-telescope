# @adonis-agora/telescope

## 0.8.4

### Patch Changes

- Fix the published package missing `dist/stubs/main.js`.

  `configure.ts` imports `{ stubsRoot } from './stubs/main.js'`, but the build ran
  `copy:stubs` _after_ `tsc` and the script did `rm -rf dist/stubs && cp -R stubs/. dist/stubs/`
  — wiping the freshly compiled `dist/stubs/main.js` and leaving only the raw
  `stubs/main.ts` behind. Every published version so far has therefore failed at
  `node ace configure` with `ERR_MODULE_NOT_FOUND` for `./stubs/main.js`.

  `copy:stubs` now only copies the stub templates (`config/`, `database/`) into
  `dist/stubs/` instead of deleting and replacing the whole directory, so the
  compiled `main.js` survives and ships in the tarball.

## 0.8.3

### Patch Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/28) [`4b6e205`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/4b6e205c87367b48c9817ca1c8e8e2b5258d51c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the commented-out examples in the published config stubs actually compile.

  Every `config/telescope_*.ts` stub documents its options as a commented block you uncomment. Three
  of those blocks did not type-check the moment you did:

  - `config/telescope_ui.ts`, `config/telescope_mcp.ts` and `config/telescope_alerts.ts` used
    `env.get(...)` in their examples without importing `env` — uncommenting one gave
    `Cannot find name 'env'`. Each now carries a commented `import env from '#start/env'` next to the
    examples that need it.
  - The `authorize` example read `ctx.auth?.user?.isAdmin`, but the hook's declared parameter is the
    framework-light `{ request, response }` slice, so `auth` is not on the type (the provider does
    pass your real `HttpContext` through at runtime). The example now narrows `ctx` explicitly, which
    is both correct and honest about why the cast is there.
  - The `geoLookup` example did `const body = await res.json()`, which is `unknown` — every
    `body.city` read was an error. It is now typed at the boundary.

  The same four fixes are applied to the docs, which carried the identical examples.

  A new test compiles every published stub inside a scratch consumer app — with the package resolved
  by name, so against the shipped `dist/**/*.d.ts` — and compiles a second copy of each config stub
  with every commented example switched on. Across the seven config stubs there are 28 lines of live
  code and 101 commented ones, so without that second pass the gate would have been watching under a
  quarter of what these files document.

  `copy:stubs` also now copies the stubs directory wholesale instead of naming each of the eight files
  in a chained `cp`, so an added stub can no longer be published as a missing file.

## 0.8.2

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/26) [`c53ba37`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/c53ba37e54418504fd39f3608e91ac6e9c76567d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop pinning 0.x peers with a caret, which npm rejects outright.

  Below 1.0 a caret does not cross a minor: `^0.32.0` means `>=0.32.0 <0.33.0`. pnpm downgrades an
  unsatisfied peer to a warning, so a workspace never notices — but **npm answers `ERESOLVE` and
  refuses to install**, and an optional peer that IS present must still match.

  `@adonis-agora/telescope` declared `"@anthropic-ai/sdk": "^0.32.0"`, which was **already broken**:
  installing it alongside any current SDK failed.

  ```
  While resolving: @adonis-agora/telescope@0.8.1
  Found: @anthropic-ai/sdk@0.116.0
  Conflicting peer dependency: @anthropic-ai/sdk@0.32.1
  ```

  It now declares `>=0.32.0 <1.0.0` — the same floor, verified to compile against every SDK minor
  from 0.32.0 through 0.116.0, with an upper bound that stops excluding them.

  `@adonis-agora/telescope-ui` declared `"@adonis-agora/telescope": "^0.8.0"`, the same defect one
  release from biting: satisfied by telescope 0.8.1 today, unsatisfiable the moment telescope cuts
  0.9.0. It now declares `>=0.7.0 <1.0.0`. The floor is 0.7.0 because that is the first release
  serving every route this console calls — `/api/retention`, `/api/profiles*`, `/api/queues/live*`,
  `/api/schedules/live` and `/api/exceptions/:id/diagnose` — not 0.5.0, which is merely where the
  provider still type-checks and where the console's Profiles, Queues, Schedules and retention
  sections would all 404.

## 0.8.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish a Node.js engine RANGE instead of one exact version. Both packages declared
  `engines.node: "v26.7.0"` — a single pinned build, written by a renovate "pin dependencies" run
  that treated a compatibility range as a version to pin. Every install
  on any other Node emitted an engine warning, and an `engine-strict` install failed outright. Both
  now declare `>=20.6.0`, the version the code actually requires, and renovate is configured to
  leave `engines` alone so the fix survives the next cycle.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the `logs` watcher safe to enable from both config files.

  `watchers: ['logs']` can be set in `config/telescope.ts` (where it also accepts a `logs`
  options block) and in `config/telescope_watchers.ts`. With both set, the second watcher to
  boot silently did nothing — and then unteed the FIRST watcher's tap on shutdown, so the
  logger was left half-instrumented. It now detects that the logger is already tapped, warns
  once naming both config keys, and stays fully inert: it records nothing and its `stop()`
  restores only what it teed itself.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Report the real package version over MCP. The `initialize` handshake advertised a hardcoded
  `0.4.0` regardless of the installed version; it now reads the package's own `VERSION`, which
  the release pipeline keeps in lockstep with `package.json`.

- [#23](https://github.com/DavideCarvalho/adonis-agora-telescope/pull/23) [`7335b3f`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/7335b3f4ffe1c885b63c1f909e9d5f2af2e94679) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restore the seven `config/*.stub` files, which shipped empty.

  Every config stub the package publishes — `telescope.stub`, `telescope_watchers.stub`,
  `telescope_ui.stub`, `telescope_ai.stub`, `telescope_alerts.stub`, `telescope_mcp.stub` and
  `telescope_cpu_profiling.stub` — was a zero-byte file in the published tarball, so
  `node ace add @adonis-agora/telescope` wrote an EMPTY `config/telescope.ts` (and an empty file
  for each feature you selected) into your app. Only the migration stub had content.

  The stubs are rebuilt from the current config surface, including everything that landed since
  they were lost: the `logs` watcher and its `logs` block, `diagnostics.exclude` /
  `diagnostics.recordClaimed`, `requestCapture`, `redact.perType`, `sampling`, `nPlusOne`, `pulse`,
  `clientErrors`, `dashboardAuth`, `cpuProfiling.armEnabled`, `queueActions`, `queueManager`, the
  `every-exception` and `metric-threshold` alert rules, `alerts.geoLookup`, and the whole
  `telescope_cpu_profiling` config. A test now fails the build if any shipped stub is empty, lacks
  its `exports(...)` header, or carries a backtick in its body — the defect that emptied them.

## 0.8.0

### Minor Changes

- [`13bc033`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/13bc033fb8bcac304e949a90716a6210677bb94d) - feat: watcher `logs` no config — tee do logger do Adonis (níveis info/warn/error/...) gravados como entries `log`, com `logs: { minLevel, tags }` opcional

## 0.7.1

### Patch Changes

- [`b3c7ef0`](https://github.com/DavideCarvalho/adonis-agora-telescope/commit/b3c7ef05e06d24175d0926a00961c8652e379417) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `enforceGuard` now honors a redirect a custom `authorize` hook already wrote to the response (a `location` header, typically via `ctx.response.redirect(...)`) instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, which already does this. Lets a host show its own branded "log in" / "access denied" page instead of raw JSON, without needing a separate config hook: redirect from inside `authorize`, return `false`, done.

  `UiResponse` (the framework-light response contract `guard.ts` and the JSON API handlers share) gained `getHeader(name)` to make the check possible; `RecordingResponse` (the in-memory test double) implements it too.

## 0.7.0

### Minor Changes

- [`8d227de`](https://github.com/DavideCarvalho/adonis-telescope/commit/8d227de32147fe58e84dd9d14d2e0cf16eebb56c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: wire AI exception diagnosis into the dashboard API + expose retention/sampling posture

  - **AI exception diagnosis**: a new `POST <path>/api/exceptions/:id/diagnose` route (optional `?force=true` to bypass the cache) re-diagnoses (or serves the cached diagnosis for) an `exception`/`client_exception` entry via the existing `DiagnosisCoordinator`. Degrades to a clear "not configured" response when `@adonis-agora/telescope/ai` isn't installed/configured — the coordinator itself was already published in 0.5.0, this just exposes it through the UI API for the first time.
  - **Retention indicator**: a new `GET <path>/api/retention` route echoes the resolved pruner cutoff (age / optional keep-last floor / cycle interval) and which entry types are being tail-sampled below 100%, so the dashboard can show a static "what's being kept" summary. No live pruner run-history — that stays a per-process runtime handle (`TelescopePruner.getRuns()`) for hosts that want it directly.
  - `GET <path>/api/meta` now always registers (previously gated behind an extension registry booting) and reports `ai.enabled` / `profiling.enabled` / `queueManager.enabled` flags alongside any extension-contributed `entryTypes`/`dashboards`.

  Both routes are additive and read-only; no existing route or response shape changed.

- [`8d227de`](https://github.com/DavideCarvalho/adonis-telescope/commit/8d227de32147fe58e84dd9d14d2e0cf16eebb56c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - feat: Live Queue Manager, Live Schedules, and CPU flamegraph profiling — three new opt-in backend capabilities

  - **Live Queue Manager** (`queue-manager` watcher, `src/watchers/queue_manager.ts`): a live list/inspect/retry/enqueue control surface over `@adonisjs/queue` (`@boringnode/queue`'s engine), distinct from the existing `queue` watcher which only records past job executions. Built strictly against `@boringnode/queue`'s real, verified public API (`getJob`/`retryJob`/`sizeOf`) — advertised via a `capabilities` getter rather than faking operations the engine doesn't support (no `remove`/`promote`). Requires explicit `queueManager.queues` in `config/telescope_watchers.ts` (the engine has no queue-enumeration API to auto-discover from) and degrades to `configured: false` when `@adonisjs/queue` isn't installed. New `GET <path>/api/queues/live`, `GET <path>/api/queues/live/:queue/jobs/:id`, and mutation routes `POST .../jobs/:id/retry` / `POST .../enqueue` (both behind a default-deny `telescope_ui.queueActions.enabled` gate, on top of the existing read guard).
  - **Live Schedules**: a new `registerSchedule()` / `unregisterSchedule()` / `listRegisteredSchedules()` API on `ScheduleWatcher` (exported from `@adonis-agora/telescope/watchers`) — an explicit, idempotent registry of "this scheduled task exists," since AdonisJS has no first-party scheduler registry to read the way `@nestjs/schedule`'s `SchedulerRegistry` can be scanned. `nextRunAt` is computed from the registered cron expression via the new OPTIONAL `cron-parser` peer (`peerDependenciesMeta` marks it `optional: true`, mirroring this repo's existing graceful-no-op convention); it's `null` — an honest "unknown," never a guess — for non-cron kinds or when the peer is absent. New `GET <path>/api/schedules/live` route joins registrations with their most recent recorded run.
  - **CPU flamegraph profiling** (`@adonis-agora/telescope/cpu_profiling`, new optional sub-entry point + `telescope_cpu_profiling_provider`): a `node:inspector`-based V8 CPU profiler, ported near-verbatim from the NestJS sibling. Opt-in per-request capture via `TelescopeMiddleware` (gated by `ProfilerService.shouldProfile`, a single cheap boolean check when the feature isn't installed), aggregated into a flamegraph tree + precomputed hot frames and recorded as a new `cpu_profile` entry type. New `GET <path>/api/profiles/status`, `GET <path>/api/profiles`, `GET <path>/api/profiles/:id`, and a manual-arm `POST <path>/api/profiles/arm` (behind a default-deny `telescope_ui.cpuProfiling.armEnabled` gate — it's real CPU overhead).

  All three are pure additive capabilities: unconfigured/uninstalled, every touchpoint degrades to inert (no overhead, 404/"not configured" responses) — no existing behavior changes.

## 0.6.0

### Minor Changes

- Parity sync from nestjs-telescope (redact binary-blob bound, client-error reorder, Slack section spread, diagnostics exclude/recordClaimed, exception alert enrichment + every-exception + isNew badge, lib:event span labels, client_exception polling, perType redaction budgets, paged ext-dashboard + trace deep-links, requestCapture gates).

## 0.5.0

### Minor Changes

- Entry pruner, event-loop overload guard, client-error ingestion; Pulse health rollup; alerter pipeline; outgoing HTTP-client watcher; MCP server endpoint; AI diagnosis coordinator; Lucid query watcher; observability UI dashboard (@adonis-agora/telescope-ui); dashboard session auth (login screen); profiling + schedule watchers.

### Patch Changes

- Export the `configure` hook from the package root so `node ace configure @adonis-agora/telescope` resolves it, and de-backtick the config stub comments that broke the tempura stub renderer.

## 0.3.3

### Patch Changes

- fix: sync VERSION across sub-entry barrels (ui/watchers/ai/alerts) and make sync-version.mjs walk every .ts under src/ so --check guards the nested literals against re-drift

## 0.3.2

### Patch Changes

- [`42c5ec9`](https://github.com/DavideCarvalho/adonis-telescope/commit/42c5ec940b02e9ffae0473c2aec7d358388e34ab) - fix: sync VERSION literal via sync-version guard

## 0.3.1

### Patch Changes

- [`67af460`](https://github.com/DavideCarvalho/adonis-telescope/commit/67af460cae249dfb852fa23c7e7b3b46715fdc88) - fix: request-replay targets the live request port (default 3333, not 3000)

## 0.3.0

### Minor Changes

- [`50cb0a6`](https://github.com/DavideCarvalho/adonis-telescope/commit/50cb0a67689f6c381b4b85ea5333ffc97b5a00bd) - Add three per-technology watchers, ports of the NestJS originals:

  - **queue** — records `@adonisjs/queue` job executions (queue, job name, payload, status, attempts, duration) by subscribing to the engine's (`@boringnode/queue`) `node:diagnostics_channel` execution trace. Optional peer: a pure no-op when nothing publishes (peer absent).
  - **events** — records every event emitted through the core `@adonisjs/core` Emitter via `emitter.onAny(...)` (name + payload), with a configurable ignore-list (`db:query` / `mail:sent` excluded by default to avoid double-recording the query/mail watchers).
  - **redis** — records `@adonisjs/redis` commands (command, args, connection, duration) by wrapping the underlying ioredis `sendCommand` on each connection (current and future, via the manager's `connection` event). Optional peer: a no-op when the manager is absent.

  All three are registered in `config/telescope_watchers.ts` with a toggle, route entries through the central redacting store, and degrade gracefully when their optional peer is missing.

  The **schedule** watcher was intentionally **skipped**: AdonisJS has no first-party scheduler (unlike `@nestjs/schedule`), and community schedulers expose no event/hook surface to tap without inventing an API. In the Agora ecosystem `@adonis-agora/durable` already bridges scheduled/cron runs onto the diagnostics bus, which the existing diagnostics watcher records — so scheduled-run observability is covered there.

- [`a3a114e`](https://github.com/DavideCarvalho/adonis-telescope/commit/a3a114e314c9fe5acbb8262dfd22b07596f62049) - feat: tail-sampling, N+1 detection, and metrics (stats/timeseries/percentiles/waterfall)

  Three data features ported from the NestJS `nestjs-telescope` originals:

  - **Tail-sampling** — a per-entry-type keep `rate` with optional `keepErrors` / `keepSlowMs` overrides, applied on the WRITE path via a `SamplingTelescopeStore` decorator so dropped entries are never persisted. The decision is a pure function with an injected RNG (deterministic in tests). Configured via `sampling` (a bare rate or per-type rules); default-off (records everything when unset).
  - **N+1 detection** — read-only analysis over stored entries grouped by trace: a flat family-count (`detectNPlusOne`) and a loop-attribution detector (`detectNPlusOnePatterns`) that names the likely driving parent and ranks loops by total wasted duration. Configured via `nPlusOne: { threshold, enabled }` (default threshold 3). Exposed at `GET <path>/api/metrics/n-plus-one/:traceId`.
  - **Metrics** — storage-agnostic aggregations over the store interface: per-type stats with p50/p95/p99 latency percentiles (raw nearest-rank + a histogram estimate that agrees within one bucket-width), per-type breakdowns (query family / cache / request status / exception groups), throughput timeseries, a trace list, and a per-trace span waterfall. Exposed at `GET <path>/api/metrics/stats`, `/api/metrics/timeseries`, `/api/metrics/traces`, and `/api/metrics/waterfall/:traceId`.

- [`e882649`](https://github.com/DavideCarvalho/adonis-telescope/commit/e8826499ff7d1af16d749f2c8b06128b64adadcd) - feat: replay a captured request from the dashboard

- [`4f03836`](https://github.com/DavideCarvalho/adonis-telescope/commit/4f03836bc5b5a5cb119ee4f9097d0c5794a99f55) - feat: SSE live-stream of telescope entries to the dashboard

  Port of the NestJS `sse/` feature. A new in-process entry-events bus (`EntryEvents`) receives every newly-persisted entry from the store's write path — published by an outermost `StreamingTelescopeStore` decorator, so only entries that were actually stored (already redacted, post-sampling — never raw) are streamed. A new `GET <telescope>/api/stream` Server-Sent-Events route (behind the existing UI guard) pushes each entry to the dashboard live as an `entry` frame, with a 15s heartbeat and client-disconnect cleanup.

  Zero-overhead by default: while no dashboard is connected the publish path is a cheap no-op. Toggle with `stream: { enabled: false }` in `config/telescope.ts` (enabled by default).

## 0.2.0

### Minor Changes

- [`b756f29`](https://github.com/DavideCarvalho/adonis-telescope/commit/b756f2995fab618db9e2ba319685099d09c3547c) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22)
