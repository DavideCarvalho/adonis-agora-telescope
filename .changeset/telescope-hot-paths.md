---
'@adonis-agora/telescope': minor
---

Redis watcher: argument values are redacted by default. Only the command and its key (the first argument) are kept; every other argument is recorded as `[REDACTED]`, arity preserved, and `AUTH` / `HELLO` / `CONFIG` / `ACL` / `MIGRATE` have every argument redacted. A session store's `SET` used to record the whole session (CSRF secret and tokens included). Set `redis.captureValues: true` in `config/telescope_watchers.ts` to record real values again.

Query watcher: `query.ignore` (SQL prefixes or RegExps, matched against the normalized template) and `query.ignoreTables` (the table a statement reads first or writes) drop noisy queries such as a job runner's polling.

Pulse covers its whole window from SQL on the `lucid` store: counts, throughput, the slowest entries and the N+1 groups are aggregated by the database, and request, cache and exception rows are read with only the content fields the cards use. It no longer stops at the newest 50,000 entries (which on a busy server was the last few minutes of the hour). New optional store reads `listSlowest` and `countTraceRepeats`, a `contentFields` hint on `list`, and `tagGroups` on `countByBucket` / `listSlowest` / `countTraceRepeats` (honored when a store sets `honorsTagGroups`), so consoles narrowed to an app or organization keep these fast paths and the throughput chart's. Stores without them scan as before. An N+1 suspect's SQL is now the newest query of the family in its worst trace.

`GET /api/apps` no longer counts tags across the whole table: it reads the newest 1,000 entries of the last hour, adds the fleet's apps on a control plane, and caches the list for 30 seconds per organization scope.
