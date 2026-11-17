---
"@adonis-agora/telescope": patch
---

A control plane stores a tenant's batch in a handful of INSERTs instead of one per entry: the ingest hands every entry of the batch to the store before awaiting any write, so the lucid store's buffered writes put them in one multi-row INSERT. Duplicates inside one batch are still counted once, and a failed write still answers 503 with the stored entries deduped on the retry.
