---
"@adonis-agora/telescope": patch
---

`S3Location.delete` now works on MinIO versions that reject `DeleteObjects` with `MissingContentMD5`: it falls back to single deletes and remembers, so the Parquet cold tier can expire and compact there.
