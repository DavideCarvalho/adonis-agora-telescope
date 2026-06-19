---
"@agora/telescope": minor
---

Initial headless release: entry model, async `TelescopeStore` contract + in-memory
store, the generic diagnostics watcher (subscribes to all `agora:<lib>:<event>`
channels), the HTTP request watcher (server middleware), the `TelescopeService`
query API, and the Adonis provider + `node ace configure` wiring.

The `TelescopeStore` methods (`record`/`get`/`list`/`count`/`prune`/`clear`) and
the `TelescopeService` query methods are async (`Promise`-returning) so a store
can be backed by a real database. `TelescopeConfig.store` accepts either
`'memory'` or a `TelescopeStore` instance (e.g. `lucidTelescopeStore(db)`).
