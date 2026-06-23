---
"@adonis-agora/telescope-watchers": minor
---

Initial release of per-technology AdonisJS watchers for `@adonis-agora/telescope`. They
subscribe to the application emitter and record framework activity as telescope
entries through the core's runtime store handle (no DI). Ships:

- `LucidQueryWatcher` — records every Lucid SQL query from `db:query` (sql,
  bindings, duration, connection, method), grouped by SQL template family-hash.
  Verified against the installed `@adonisjs/lucid` types. Enabled by default.
- `MailWatcher` — records `mail:sent` as a `mail` entry (mailer, from, to, subject).
- `CacheWatcher` — records `@adonisjs/cache` hit/miss/write/delete/clear events as
  `cache` entries (operation, key, store), with an overridable event-name map.

`mail` / `cache` are opt-in: `@adonisjs/mail` and `@adonisjs/cache` are not present
in this repo, so their event contracts could not be verified against their types
and are implemented defensively (best-effort). A provider reads
`config/telescope_watchers.ts` (default: `query` on) and starts/stops the enabled
watchers on boot/shutdown. Recording is fire-and-forget and never throws into the
host app. Ships `configure.ts` + stub.
