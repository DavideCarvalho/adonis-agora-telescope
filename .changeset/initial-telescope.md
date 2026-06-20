---
"@agora/telescope": minor
---

Initial headless release: entry model, async `TelescopeStore` contract + in-memory
store, the generic diagnostics watcher (subscribes to all `agora:<lib>:<event>`
channels), the HTTP request watcher (server middleware), the `TelescopeService`
query API, and the Adonis provider + `node ace configure` wiring.

The `TelescopeStore` methods (`record`/`get`/`list`/`count`/`prune`/`clear`) and
the `TelescopeService` query methods are async (`Promise`-returning) so a store
can be backed by a real database.

Storage is config-driven via the `storage` factory: `config/telescope.ts` lists
named drivers under `stores` and selects the active one with `store`. Two drivers
ship — `storage.memory({ limit })` (the bounded ring buffer) and `storage.lucid({ connection })`
(a persistent, SQL-backed store on AdonisJS Lucid, absorbed from the former
`@agora/telescope-lucid` package). `@adonisjs/lucid` is an optional peer dependency,
imported lazily only when the `lucid` driver is selected; `configure` also publishes
the `create_telescope_entries_table` migration. `store` still also accepts the bare
`'memory'` literal or a `TelescopeStore` instance for a hand-wired backend.
