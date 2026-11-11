---
"@adonis-agora/telescope-ui": patch
---

Fix arming a CPU capture from the dashboard: `TelescopeClient#armProfile(count, label)` now sends `count` and `label` in the JSON request body, which is where the arm route reads them. Before, they went in the query string and every arm captured one request with no label.

The overview no longer requests `<path>/api/queues/live` when `/meta` reports no queue manager, so an app without the `queue-manager` watcher stops logging a 404 on every overview load.
