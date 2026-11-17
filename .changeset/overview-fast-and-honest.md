---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": minor
---

Overview on a central server: honest "Not measured" notes, and far fewer rows read.

- Heartbeats carry the watchers each instance runs. On a control plane `/api/meta` `watchers` is the union of what the apps in view report (narrowed by `?app=`), so "N+1 query hotspots" and "Slowest jobs" stop saying "Not measured" when a tenant does record queries or jobs. When an app in view runs an older version that does not report them, `watchers` is left out and the console claims nothing.
- `/api/metrics/pulse` takes `cards=` to compute only some cards. The Overview asks for the cards it shows and draws its throughput chart from the same response, instead of a second whole-window scan through `/api/metrics/timeseries`.
- New migration `add_telescope_entries_overview_indexes` (published by `configure`): indexes for the Overview and Pulse reads, built `CONCURRENTLY` on Postgres, plus tighter autovacuum thresholds on the entries table. On a 4.3M-row table a 24-hour Overview read about 0.7 GB of buffers instead of about 9.7 GB (pulse + timeseries). Opt-in: run it once on existing installs.
