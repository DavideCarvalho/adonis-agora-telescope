---
'@adonis-agora/telescope': minor
---

`RecordInput` accepts an optional `createdAt` (a `Date` or an ISO string) and `id`, for entries recorded on another machine and stored later. The memory, lucid and tiered/parquet stores keep them. Reads, time windows, metrics and prune follow the given time, and the memory store keeps its entries in `createdAt` order. A time more than 5 minutes in the future, or an invalid one, is taken as now, so a sender cannot push its entries ahead of everyone else's. An id must be 1–255 printable characters; recording an id the store already holds stores nothing new. `resolveCreatedAt` and `resolveEntryId` are exported for custom stores. Entries recorded without these fields behave as before.
