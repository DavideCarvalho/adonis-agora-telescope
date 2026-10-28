---
"@adonis-agora/telescope": patch
---

Fix a permanently broken store after concurrent boots, fold repeated record failures into one line per minute, and stop importing `@anthropic-ai/sdk` at boot.

- `LucidTelescopeStore` (`autoCreateTable`): when several processes boot against a fresh Postgres at once, `CREATE TABLE IF NOT EXISTS "telescope_schema_meta"` can fail with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. The rejected init was cached for the life of the process, so every later entry failed. Concurrent-DDL errors are now retried (they become the no-op `IF NOT EXISTS` meant), a concurrent marker insert is tolerated, and any failed init is retried after 5s instead of being cached forever.
- Record-failure logs (`RedisWatcher`/`LucidQueryWatcher`/… `failed to record telescope entry`, `TelescopeMiddleware`, `DiagnosticsWatcher`, client errors) print the first occurrence of each distinct failure at once, then one line per minute with how many identical failures it stood for, instead of one synchronous stderr line per entry (~145k lines per pod in a multi-pod load test).
- The AI diagnoser builds its Anthropic client lazily: the optional `@anthropic-ai/sdk` peer is imported on the first diagnosis, not when the provider boots.
