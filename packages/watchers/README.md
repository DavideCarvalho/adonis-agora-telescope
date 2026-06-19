# @agora/telescope-watchers

Per-technology [`@agora/telescope`](../core) watchers for AdonisJS. They subscribe
to the application **emitter** and record framework activity as queryable telescope
entries — without dependency injection, by recording through the telescope runtime
store handle the core publishes at boot.

## Watchers

| Watcher | Event | Entry | Status |
| --- | --- | --- | --- |
| `LucidQueryWatcher` | `db:query` | `query` (sql, bindings, durationMs, connection, method) | **verified** against the installed `@adonisjs/lucid` types |
| `MailWatcher` | `mail:sent` | `mail` (mailer, from, to, subject) | best-effort — see below |
| `CacheWatcher` | `cache:hit` / `cache:miss` / `cache:written` / `cache:deleted` / `cache:cleared` | `cache` (operation, key, store) | best-effort — see below |

The **Lucid query watcher** is the headline feature and the only one enabled by
default. Its `db:query` payload (`{ connection, sql, method, bindings?, duration?, model?, inTransaction? }`,
with `duration` a `process.hrtime()` `[seconds, nanoseconds]` tuple) was verified
against `@adonisjs/lucid`'s `DbQueryEventNode` type.

> **Note on `mail` and `cache`** — `@adonisjs/mail` and `@adonisjs/cache` are not
> installed in this repository, so their event names and payload shapes could not
> be verified against their types. Those watchers are implemented **defensively**:
> every field is read optionally and missing data degrades to `null`/`[]` rather
> than assuming a shape. The cache event-name → operation map is exported
> (`CACHE_EVENTS`) and overridable via the `CacheWatcher` constructor if a future
> version diverges. Treat both as best-effort until validated against a live app.

## Install

```sh
npm i @agora/telescope-watchers
node ace configure @agora/telescope-watchers
```

`configure` registers the provider and publishes `config/telescope_watchers.ts`.

## Configure

```ts
// config/telescope_watchers.ts
import { defineConfig } from '@agora/telescope-watchers'

export default defineConfig({
  watchers: ['query'], // add 'mail' / 'cache' to enable them
})
```

The provider resolves the application emitter on boot and starts each enabled
watcher; it stops (fully unsubscribes) them on shutdown. Recording is
fire-and-forget and fully guarded — a telescope failure can never break or block
an observed code path.

> Lucid only emits `db:query` when the connection's `debug` flag is enabled (or a
> `db:query` listener exists). Enable `debug` in your DB config to guarantee
> capture.

## Programmatic use

Every watcher is `start(emitter)` / `stop()` and can be driven against any emitter
with an `on(event, listener) => unsubscribe` surface:

```ts
import emitter from '@adonisjs/core/services/emitter'
import { LucidQueryWatcher } from '@agora/telescope-watchers'

const watcher = new LucidQueryWatcher()
watcher.start(emitter as never)
// ... later
watcher.stop()
```
