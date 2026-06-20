# `@agora/telescope`

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
npm i @agora/telescope
node ace configure @agora/telescope
```

`configure` registers the core provider, plugs `TelescopeMiddleware` onto the `server`
middleware stack (the HTTP request watcher), publishes `config/telescope.ts`, and then
prompts you for which [optional features](#optional-features) to enable — registering
each chosen provider and publishing its config.

## Optional features

Everything is **one published package, `@agora/telescope`**. Each feature is a subpath,
following the first-party AdonisJS convention (`@adonisjs/auth`'s guards). You install
only the optional peers for the features you actually use.

| Subpath | Provider subpath | What | Optional peers |
|---|---|---|---|
| [`@agora/telescope/watchers`](./docs/packages/watchers.mdx) | `@agora/telescope/watchers_provider` | records Lucid SQL queries (`db:query`), mail-sent and cache events | `@adonisjs/lucid`, `@adonisjs/mail`, `@adonisjs/cache` |
| [`@agora/telescope/ui`](./docs/packages/ui.mdx) | `@agora/telescope/ui_provider` | self-contained web dashboard + JSON API behind an auth guard | — |
| [`@agora/telescope/ai`](./docs/packages/ai.mdx) | `@agora/telescope/ai_provider` | Claude-powered exception diagnosis | `@anthropic-ai/sdk` |
| [`@agora/telescope/alerts`](./docs/packages/alerts.mdx) | `@agora/telescope/alerts_provider` | new-exception alerts to Slack / webhook / console | — |

## What it records

| Watcher | Entry type | What |
|---|---|---|
| **request** | `request` | every inbound HTTP request — method, url, status, duration, traceId |
| **diagnostics** | `diagnostic` | every `agora:<lib>:<event>` publish from any `@agora/*` library that uses `@agora/diagnostics` — one entry per event, grouped by `lib:event` |

The diagnostics watcher is the key integration: ONE generic watcher subscribes to
**all** diagnostics channels (current and future) and records each publish — no
bespoke watcher per library.

## Query it

```ts
import { TelescopeService } from '@agora/telescope'

const telescope = await app.container.make(TelescopeService)

telescope.list({ type: 'request', limit: 50 })   // recent requests, newest-first
telescope.byTrace('abc123')                       // every entry on one trace
telescope.list({ tag: 'lib:billing', search: 'invoice' })
telescope.topFamilies(10, 'diagnostic')           // busiest lib:event pairs
telescope.find(entryId)
```

Expose a tiny inspector endpoint with it, or just read it from a test.

## Cross-repo decoupling (zero `@agora/*` deps)

Telescope is a **separate repo** and does not depend on any `@agora/*` package. It
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
import { defineConfig, storage } from '@agora/telescope'

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
import { defineConfig, storage } from '@agora/telescope'

export default defineConfig({
  store: 'lucid',
  stores: { lucid: storage.lucid() },
})
```

The `lucid` driver needs a table — publish the migration with
`node ace configure @agora/telescope` (it ships the `create_telescope_entries_table`
stub) and run `node ace migration:run`. Every store implements the same
`TelescopeStore` contract (`record` / `get` / `list` / `count` / `prune` / `clear`);
a custom backend implements the same contract and is passed as a `store` instance.

## Roadmap

The NestJS original is 18 packages. This port ships the headless core plus the
[optional feature subpaths](#optional-features) above (UI, watchers, AI, alerts).
Still planned, not built (see [`DESIGN.md`](./DESIGN.md) for rationale):

- More per-tech watchers: bullmq / mikro-orm / typeorm / prisma / redis / sqs / schedule.
- OTel export.

## The Agora ecosystem

Agora is the AdonisJS port of the aviary NestJS ecosystem. `@agora/telescope`
composes with [`@agora/context`](https://github.com/DavideCarvalho/adonis-context)
(trace correlation) and [`@agora/diagnostics`](https://github.com/DavideCarvalho/adonis-diagnostics)
(the events it records) — but depends on neither.

## License

MIT © Davi Carvalho
