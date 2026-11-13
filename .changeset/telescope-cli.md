---
"@adonis-agora/telescope": minor
---

Every console screen and action is now a `node ace telescope:<noun>:<verb>` command: entries (list, show, export, prune, clear), traces (list, show, waterfall, N+1), overview, Pulse, per-type metrics and timeseries, screens, exceptions (list, AI diagnose), AI usage, retention, request replay, live queues and jobs (show, retry, enqueue), schedules, CPU profiles, organizations, features and extension data/actions. The commands run the console's own handlers, so filters, limits and the `replay`/`queueActions` gates are the console's. `--json` on every command, `--tenant` to narrow to one organization, and `--force` to skip the confirmation of destructive actions (they refuse without a terminal otherwise). See the new CLI page.
