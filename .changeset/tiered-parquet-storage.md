---
'@adonis-agora/telescope': minor
---

Add a tiered store: `storage.tiered({ hot, cold: storage.parquet({ location, engine }), hotFor })` keeps a hot driver (usually `storage.lucid()`) minutes deep and, on each prune cycle, moves older entries to hourly Parquet files in a directory or on S3 (through the host's own `S3Client`), deleting them from the hot tier only after the files are written. Reads route hot-then-cold and merge newest-first without duplicates, so `{ page, size }` pages across the tier boundary. The cold tier is read with pure-JS hyparquet by default, or DuckDB (`engine: 'duckdb'`, optional peer `@duckdb/node-api`), which is started with extension auto-load off and external access limited to its data directory, so it never loads `httpfs`/`aws`. New optional peers: `hyparquet`, `hyparquet-writer`, `hyparquet-compressors`, `@duckdb/node-api`, `@aws-sdk/client-s3`. See the new "Scaling storage" docs page.
