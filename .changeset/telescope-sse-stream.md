---
'@adonis-agora/telescope': minor
---

feat: SSE live-stream of telescope entries to the dashboard

Port of the NestJS `sse/` feature. A new in-process entry-events bus (`EntryEvents`) receives every newly-persisted entry from the store's write path — published by an outermost `StreamingTelescopeStore` decorator, so only entries that were actually stored (already redacted, post-sampling — never raw) are streamed. A new `GET <telescope>/api/stream` Server-Sent-Events route (behind the existing UI guard) pushes each entry to the dashboard live as an `entry` frame, with a 15s heartbeat and client-disconnect cleanup.

Zero-overhead by default: while no dashboard is connected the publish path is a cheap no-op. Toggle with `stream: { enabled: false }` in `config/telescope.ts` (enabled by default).
