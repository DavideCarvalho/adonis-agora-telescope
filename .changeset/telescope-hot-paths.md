---
"@adonis-agora/telescope": minor
---

Faster recording and dashboard reads on the `lucid` store, and a fix for an endless write loop.

- The `lucid` store batches writes: every entry recorded in one tick of the event loop goes out
  in one multi-row INSERT (split under each dialect's bind limit). The buffer is bounded at
  10,000 waiting entries; past that new entries are dropped and counted on `droppedCount`.
  `record()` still resolves once its entry is written.
- The request middleware no longer waits for its entry to be written before the response is
  sent. Recording failures are now reported on `console.error` instead of swallowed.
- The store's own queries are no longer recorded by the query watcher. With the store on the
  app's connection and `debug: true`, each INSERT was recorded as a query entry, whose INSERT was
  recorded in turn, forever.
- The redaction, sampling, streaming and OTel store decorators expose the optional fast paths
  (`listTraceIds`, `countByBucket`, and the new `countFamilies` / `countTags`) when the store
  they wrap has them, so the throughput chart and traces screen stop falling back to a full scan.
- Pulse and per-type stats scan their window without `content` (new `EntryQuery.omitContent`
  hint) and read content only for the rows they display. `/api/stats` counts families with
  `GROUP BY` and tags from the `tags` column alone. The throughput chart is grouped in SQL.
- New composite indexes `(type, created_at, sequence)` and `(family_hash, created_at)` replace
  the single-column `type` and `family_hash` ones in the migration stub; `autoCreateTable` adds
  them on the next boot. Apps that ran the migration should add them with their own migration
  (see the storages docs).
- `prune` deletes oldest-first in bounded batches, so a backlog larger than the database's bind
  limit no longer makes every prune fail; the tiered store moves entries to cold by time instead
  of by offset.
- Watchers build an entry only once it will be recorded (not while paused), and the query
  watcher templates SQL into its `familyHash` only for entries that survive sampling.
- Redaction remembers which keys are masked instead of lowercasing every key of every entry, and
  never reads the value of a key it masks.
- Latency percentiles no longer throw `RangeError` on windows with more than ~120k durations.
