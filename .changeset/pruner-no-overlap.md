---
"@adonis-agora/telescope": patch
---

The pruner no longer starts a scheduled cycle while the last one is running, which duplicated entries in the cold tier during long moves. `storage.parquet` now keeps a ready-made location that has a field named `s3` or `dir` instead of replacing it.
