# @agora/telescope-lucid

A persistent, SQL-backed [`TelescopeStore`](../core) for
[`@agora/telescope`](../core) built on **AdonisJS Lucid**. Telescope entries are
written through Lucid's async query builder, so they survive restarts and stay
queryable from your database on **any Lucid dialect** (sqlite, Postgres, MySQL) —
no synchronous driver handle, no dialect lock-in.

## Install

```sh
npm i @agora/telescope-lucid
# peers: @adonisjs/core ^6.12.0, @adonisjs/lucid ^21
```

## Schema

Publish the migration stub (recommended) so the schema is versioned:

```sh
node ace make:migration create_telescope_entries_table
```

…copy the body from
[`stubs/database/migrations/create_telescope_entries_table.stub`](./stubs/database/migrations/create_telescope_entries_table.stub),
then `node ace migration:run`. For tests/scripts you can instead let the store
create the table on first use (`autoCreateTable: true`) or call
`createTelescopeTable(db)`.

## Use

In `config/telescope.ts`:

```ts
import db from '@adonisjs/lucid/services/db'
import { defineConfig } from '@agora/telescope'
import { lucidTelescopeStore } from '@agora/telescope-lucid'

export default defineConfig({
  store: lucidTelescopeStore(db),
})
```

## API

- `lucidTelescopeStore(db, options?)` — factory returning a `LucidTelescopeStore`.
- `LucidTelescopeStore` — implements the async `TelescopeStore` contract
  (`record` / `get` / `list` / `count` / `prune` / `clear`).
- `createTelescopeTable(db, options?)` — idempotent DDL helper.
- `createTableStatements(tableName?)` — the raw `CREATE TABLE` / index statements.

### Options

| Option            | Default              | Description                                                        |
| ----------------- | -------------------- | ------------------------------------------------------------------ |
| `tableName`       | `telescope_entries`  | Table to read/write.                                               |
| `autoCreateTable` | `false`              | Run the DDL on first use (handy for tests; prefer a migration).    |
| `maxEntries`      | _unset_              | Advisory cap for scheduled `prune` trimming (no auto-evict).       |

`content` and `tags` are stored as JSON text and round-tripped on read;
`created_at` is epoch-milliseconds so ordering and age-based pruning are plain
integer comparisons across drivers.
