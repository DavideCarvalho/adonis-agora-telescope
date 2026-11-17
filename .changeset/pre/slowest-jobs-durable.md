---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": minor
---

"Slowest jobs" shows durable workflow steps, and its empty state tells the truth.

- Pulse has a new `slowWork` list (with the `slowJobs` card): the slowest background work of the window by p95, with max, count and failures, merging queue jobs (`queue` watcher) and `@adonis-agora/durable` steps, each labelled with its source. Durable steps are read from the timed `durable:step.*` diagnostic entries through a new optional store read, `listDurations`, which selects only `family_hash` and `duration_ms` (an index-only scan with the opt-in overview indexes). `slowJobs` is unchanged.
- The Overview's "Slowest jobs" panel lists both. With nothing to list it says "Not measured" only when neither durable nor the `queue` watcher is on, and then names both ways to turn one on; when durable is reporting it says no workflow step finished in the window.
- `registerTenantWatchers()`: a control plane can name watchers it runs for its tenants (durable's control-plane watcher adds `durable`), and `/api/meta` counts them on for every app in view.
