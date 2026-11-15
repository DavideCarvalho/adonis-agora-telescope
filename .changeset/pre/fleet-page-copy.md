---
'@adonis-agora/telescope-ui': patch
---

Fleet page: no hardcoded heartbeat timings (the server's `fleet.interval`/`goneAfter` may differ), an `unknown` check card stays neutral like its badge, and a deploy with no live instances says so instead of `0/0 live`.
