---
"@agora/telescope-lucid": minor
---

Initial release of the persistent, SQL-backed `TelescopeStore` on AdonisJS Lucid.
`LucidTelescopeStore` / `lucidTelescopeStore(db, opts?)` persist telescope entries
to a `telescope_entries` table via Lucid's async query builder, so they work on
every Lucid dialect (sqlite / Postgres / MySQL). Ships a `createTelescopeTable(db)`
DDL helper and an Adonis migration stub. Entries survive restarts and `sequence`
is reseeded from `MAX(sequence)` so it keeps climbing.
