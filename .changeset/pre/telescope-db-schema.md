---
'@adonis-agora/telescope': minor
---

`storage.lucid({ schema })` puts telescope's tables in a database schema other than the connection's (a Postgres schema, a MySQL database). Every statement names the schema, so it works on any connection without `searchPath`; `autoCreateTable` creates the schema when missing, the migration stub takes the same `schema`, `createTelescopeTable` / `createTableStatements` accept it, SQLite fails at boot when it is set, and `agora:doctor --deep` checks the schema (`telescope.db-schema`). Without `schema` nothing changes.
