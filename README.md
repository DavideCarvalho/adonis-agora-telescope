# `@adonis-agora/telescope`

> Laravel Telescope-style **headless** observability for **AdonisJS** — records
> every HTTP request and every `agora:<lib>:<event>` diagnostics publish as a
> queryable **entry**, so you (or a future dashboard) can answer "what just
> happened on trace `X`?".

This is the AdonisJS port of the [aviary](https://github.com/DavideCarvalho?tab=repositories)
`nestjs-telescope` library. The **headless core** records into a store and exposes a
query API; the dashboard, per-technology watchers, AI diagnosers and alerts ship as
**opt-in subpaths of this same package** (see [Optional features](#optional-features)).

## Install

```sh
npm i @adonis-agora/telescope
node ace configure @adonis-agora/telescope
```

`configure` registers the core provider, plugs `TelescopeMiddleware` onto the `server`
middleware stack (the HTTP request watcher), publishes `config/telescope.ts`, and then
prompts you for which [optional features](#optional-features) to enable — registering
each chosen provider and publishing its config.

## Optional features

Everything is **one published package, `@adonis-agora/telescope`**. Each feature is a subpath,
following the first-party AdonisJS convention (`@adonisjs/auth`'s guards). You install
only the optional peers for the features you actually use.

| Subpath | Provider subpath | What | Optional peers |
|---|---|---|---|
| [`@adonis-agora/telescope/watchers`](./docs/packages/watchers.mdx) | `@adonis-agora/telescope/watchers_provider` | per-technology watchers — Lucid `query`, `http-client`, `logs`, `mail`, `cache`, `queue`, `events`, `redis`, plus user-driven `profiling` + `schedule` | `@adonisjs/lucid`, `@adonisjs/mail`, `@adonisjs/cache`, `@adonisjs/queue`, `@adonisjs/redis` |
| [`@adonis-agora/telescope/ui`](./docs/packages/ui.mdx) | `@adonis-agora/telescope/ui_provider` | JSON API + SSE live-stream behind an auth guard (+ opt-in [request replay](./docs/packages/ui.mdx)) | — |
| [`@adonis-agora/telescope/ai`](./docs/packages/ai.mdx) | `@adonis-agora/telescope/ai_provider` | Claude-powered exception diagnosis, cached by family | `@anthropic-ai/sdk` |
| [`@adonis-agora/telescope/alerts`](./docs/packages/alerts.mdx) | `@adonis-agora/telescope/alerts_provider` | new-exception / exception-rate / metric-threshold alerts to Slack / webhook / console / custom, with optional [geo-enrichment](./docs/packages/alerts.mdx) | — |
| [`@adonis-agora/telescope/mcp`](./docs/packages/mcp.mdx) | `@adonis-agora/telescope/mcp_provider` | Model Context Protocol endpoint so a coding agent can query the captured telemetry | — |

The React dashboard **page** ships as a separate pre-built package,
[`@adonis-agora/telescope-ui`](./docs/packages/telescope-ui.mdx), served under the same prefix
and guard as the `ui` API.

Baked into the **core** package root (no separate subpath): [Pulse](./docs/packages/pulse.mdx)
(at-a-glance health rollup), the [Metrics API](./docs/packages/metrics.mdx) (percentiles /
timeseries / traces / waterfalls / N+1 detection), [client-error
ingestion](./docs/packages/client-errors.mdx) (browser-reported front-end errors), and the
[advanced store decorators](./docs/packages/advanced.mdx) — bounded redaction, tail-sampling,
and the live-stream bus.

## What it records

The **core** ships three always-on watchers:

| Watcher | Entry type | What |
|---|---|---|
| **request** | `request` | every inbound HTTP request — method, url, status, duration, traceId |
| **exception** | `exception` | every unhandled HTTP exception — class, message, stack, correlated to its request |
| **diagnostics** | `diagnostic` | every `agora:<lib>:<event>` publish from any `@adonis-agora/*` library that uses `@adonis-agora/diagnostics` — one entry per event, grouped by `lib:event` |

The diagnostics watcher is the key integration: ONE generic watcher subscribes to
**all** diagnostics channels (current and future) and records each publish — no
bespoke watcher per library.

The [`watchers` subpath](./docs/packages/watchers.mdx) adds per-technology watchers, each
correlated to the active trace:

| Watcher | Entry type | What |
|---|---|---|
| **query** | `query` | every Lucid SQL statement (`db:query`) — sql, bindings, duration, connection; N+1 grouping |
| **http-client** | `http-client` | every outbound `fetch` — method, sanitized url, host, status, duration |
| **logs** | `log` | AdonisJS logger output — level, message, bounded structured context |
| **mail** | `mail` | every email sent (`mail:sent`) — mailer, from, to, subject |
| **cache** | `cache` | `@adonisjs/cache` hit / miss / write / delete / clear events |
| **queue** | `job` | `@adonisjs/queue` job executions — queue, name, payload, outcome, attempts, duration |
| **events** | `event` | every event emitted through the core Emitter (`onAny`), minus a default ignore-list |
| **redis** | `redis` | every `@adonisjs/redis` command — command, args, connection, round-trip duration |
| **profiling** | `profile` | user-instrumented timing spans via `profile()` / `startProfile()` |
| **schedule** | `scheduled_task` | scheduled-task runs via `scheduleTask()` / `recordScheduledRun()` |

Browser-reported front-end errors ([client-error
ingestion](./docs/packages/client-errors.mdx)) are recorded as `client_exception` entries.
Every stored entry passes through the redaction + optional tail-sampling
[store decorators](./docs/packages/advanced.mdx) before it persists.

## Query it

```ts
import { TelescopeService } from '@adonis-agora/telescope'

const telescope = await app.container.make(TelescopeService)

telescope.list({ type: 'request', limit: 50 })   // recent requests, newest-first
telescope.byTrace('abc123')                       // every entry on one trace
telescope.list({ tag: 'lib:billing', search: 'invoice' })
telescope.topFamilies(10, 'diagnostic')           // busiest lib:event pairs
telescope.find(entryId)
```

Expose a tiny inspector endpoint with it, or just read it from a test.

## Cross-repo decoupling (zero `@adonis-agora/*` deps)

Telescope is a **separate repo** and does not depend on any `@adonis-agora/*` package. It
reads two cross-copy-stable global slots **structurally**:

- `Symbol.for('@agora/diagnostics:registry')` — `{ channels, listeners }`. The
  diagnostics watcher iterates `channels` for current channel names and adds to
  `listeners` to learn of future ones, then subscribes via the Node builtin
  `node:diagnostics_channel`.
- `Symbol.for('@agora/context:accessor')` — the request's active `traceId()` for
  correlation.

When those packages aren't installed, telescope degrades gracefully (no trace
correlation, no diagnostic entries) — the request watcher still works standalone.

## Configuration

`config/telescope.ts`:

```ts
import { defineConfig, storage } from '@adonis-agora/telescope'

export default defineConfig({
  enabled: true,                          // master switch
  store: 'memory',                        // which driver in `stores` is active
  stores: {
    memory: storage.memory({ limit: 1000 }),   // bounded in-process ring buffer
    // lucid: storage.lucid({ connection: 'pg' }), // persistent SQL store
  },
  watchers: ['request', 'diagnostics'],   // omit one to disable it
})
```

## Storage

Storage is a **config-driven driver**, built with the `storage` factory and selected
by `store`. Two drivers ship in the box:

- **`memory`** — `InMemoryTelescopeStore`, a bounded ring buffer (great for dev/tests,
  lost on restart). `storage.memory({ limit })`.
- **`lucid`** — `LucidTelescopeStore`, a persistent, SQL-backed store on
  [`@adonisjs/lucid`](https://lucid.adonisjs.com) (sqlite / Postgres / MySQL), so
  entries survive restarts. `storage.lucid({ connection })`. `@adonisjs/lucid` is an
  **optional peer** — imported lazily only when the `lucid` driver is selected.

```ts
import { defineConfig, storage } from '@adonis-agora/telescope'

export default defineConfig({
  store: 'lucid',
  stores: { lucid: storage.lucid() },
})
```

The `lucid` driver needs a table — publish the migration with
`node ace configure @adonis-agora/telescope` (it ships the `create_telescope_entries_table`
stub) and run `node ace migration:run`. Every store implements the same
`TelescopeStore` contract (`record` / `get` / `list` / `count` / `prune` / `clear`);
a custom backend implements the same contract and is passed as a `store` instance.

## Roadmap

The NestJS original is 18 packages. This port ships the headless core (request / exception /
diagnostics watchers, Pulse, the [Metrics API](./docs/packages/metrics.mdx), client-error
ingestion, redaction + tail-sampling + live-stream decorators) plus the
[optional feature subpaths](#optional-features) above — the full watcher set
(`query` / `http-client` / `logs` / `mail` / `cache` / `queue` / `events` / `redis` /
`profiling` / `schedule`), the dashboard UI + SPA, AI diagnosis, alerts, and MCP.

Still planned, not built (see [`DESIGN.md`](./DESIGN.md) for rationale):

- More ORM/queue watchers: bullmq / mikro-orm / typeorm / prisma / sqs.
- OTel export.

## The Agora ecosystem

Agora is the AdonisJS port of the aviary NestJS ecosystem. `@adonis-agora/telescope`
composes with [`@adonis-agora/context`](https://github.com/DavideCarvalho/adonis-context)
(trace correlation) and [`@adonis-agora/diagnostics`](https://github.com/DavideCarvalho/adonis-diagnostics)
(the events it records) — but depends on neither.

## License

MIT © Davi Carvalho
