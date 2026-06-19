# `@agora/telescope` — design

A headless port of the `nestjs-telescope` observability library to AdonisJS. The
NestJS original is **18 packages** (a UI dashboard, AI diagnosers, alerts, OTel,
~12 ORM/queue watchers). This port deliberately delivers a **usable headless
core** and documents the rest as planned.

## What's shipped (v0.1)

| Piece | File | Notes |
|---|---|---|
| Entry model | `src/entry.ts` | `Entry` + `RecordInput` + `EntryType`. Adapted from the nestjs core, trimmed to the headless fields (no `batchId`/`spanId`/`instanceId`). Reserved entry-type values keep future watchers non-breaking. |
| Storage contract | `src/store.ts` | `TelescopeStore` — `record` / `get` / `list` / `count` / `prune` / `clear`, plus an `EntryQuery` (type / tag / familyHash / traceId / before / after / search / limit). |
| In-memory store | `src/in_memory_store.ts` | Bounded ring buffer (default 1000), newest-first, id index, search over content + tags, keepLast-aware prune. |
| Diagnostics watcher | `src/diagnostics_watcher.ts` | The KEY integration. ONE generic watcher subscribing to all `agora:<lib>:<event>` channels. |
| Request watcher | `src/request_watcher.ts` + `src/telescope_middleware.ts` | Pure `recordRequest()` core (unit-testable) + the `server` middleware shell. |
| Query API | `src/service.ts` | `TelescopeService` — list / find / byTrace / topFamilies / topTags. |
| Config | `src/define_config.ts` | `defineConfig` + `resolveConfig` (enabled / store / maxEntries / watchers). |
| Adonis wiring | `providers/telescope_provider.ts`, `configure.ts`, `stubs/` | Provider (register/boot/shutdown), `node ace configure` codemods, config stub. |

## Key decisions

### Cross-repo decoupling via global Symbol slots

Telescope is a separate repo and has **no `@agora/*` dependencies** (they can't be
resolved across repos, and a hard dep would couple their release cadences).
Instead it reads two cross-copy-stable `globalThis[Symbol.for(...)]` slots
**structurally**:

- **`@agora/diagnostics:registry`** → `{ channels: Set<string>, listeners:
  Set<(name) => void> }`. `node:diagnostics_channel` has no wildcard subscribe, so
  the watcher subscribes to every name in `channels` *and* registers a `listeners`
  callback to catch channels that appear later. Subscribing also flips each
  producer's `channel.hasSubscribers`, which is what makes `@agora/diagnostics`
  start building + publishing envelopes (zero overhead when nobody listens). The
  actual subscribe uses the Node builtin `node:diagnostics_channel` — no Agora
  import.
- **`@agora/context:accessor`** → `{ traceId(), tenantId(), userRef(), get() }`.
  The store reads `traceId()` at record time for request correlation.

Both readers degrade to `undefined` when the package is absent. The
`DiagnosticEvent` envelope and the `ContextAccessor` shape are defined **locally**
(mirrored, not imported).

### Watcher core split from middleware

`recordRequest()` is a pure function over an `HttpContextLike` so it unit-tests
with a plain object. `TelescopeMiddleware` is the thin Adonis shell that wraps the
pipeline (records in a `finally`, so it captures the final status and never breaks
a request).

### Runtime handle outside the container

The middleware reads the active store from a `Symbol.for('@agora/telescope:runtime')`
slot rather than via DI, so it needs no constructor wiring and is a true no-op
(zero allocation) when telescope is disabled. The provider sets the slot at `boot`
and clears it at `shutdown`.

### familyHash grouping

Diagnostic entries are grouped by `lib:event` (e.g. `billing:invoice-paid`) so the
query API's `topFamilies()` can roll up the busiest event kinds — the same
grouping the NestJS dashboard's "busiest events" panel used.

## Deferred (documented, not built)

| Deferred | Why / next step |
|---|---|
| **UI dashboard** | The obvious next step. The headless query API (`TelescopeService`) is exactly what it would read. |
| **`@agora/telescope-lucid`** | (a) a query watcher that records Lucid SQL as `query` entries via Lucid's emitted events, and (b) a persistent `TelescopeStore` backed by a Lucid/SQLite table — the production storage answer. |
| **Per-tech watchers** | bullmq / mikro-orm / typeorm / prisma / redis / sqs / schedule / mail / cache — most become trivial once they emit through `@agora/diagnostics` (the generic watcher already records them); only richer typed `content` needs bespoke code. |
| **AI diagnosers** | LLM-assisted root-causing over recorded entries. |
| **Alerts** | `new-exception` and family-seen dedup (needs an atomic `markFamilySeen` on the store contract). |
| **OTel export** | Bridge entries / the diagnostics span channels to an OTel exporter. |
| **Rollups / keyset cursors / per-type retention** | Present in the nestjs `StorageProvider`; trimmed here. The `EntryQuery` uses simple `before`/`limit` instead of opaque cursors. |

## Testing

`vitest` (swc transform). 37 tests across:

- **in-memory store** — record/get/list, every filter, search, ring-buffer
  eviction, prune (+ keepLast), clear, explicit traceId/origin.
- **diagnostics watcher** — publish on a channel registered *before* and *after*
  start (future-channel discovery), malformed-envelope rejection, stop
  unsubscribes, registry-absent no-op, idempotent start, legacy-envelope mapping.
  The test installs a stand-in registry on the global slot and replicates
  `@agora/diagnostics`' `registerChannel` contract, then publishes on a real
  `node:diagnostics_channel`.
- **request watcher** — method/url/status/duration, query-string stripping,
  missing status, duration & traceId overrides.
- **service** — list/find/byTrace/topFamilies/topTags.
- **config + middleware** — `resolveConfig` defaults/overrides, middleware no-op
  vs recording vs disabled, records-on-throw + re-throw, and context-accessor
  trace correlation.
