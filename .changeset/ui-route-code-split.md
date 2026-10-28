---
'@adonis-agora/telescope-ui': patch
---

perf(ui): split the dashboard SPA per section with `React.lazy`. The shell and the landing Overview load up front; every other section (Entries, Entry/Trace detail, Traces, Screens, Pulse, Exceptions, Queues, Schedules, Exports, Profiles, extension dashboards) is fetched the first time it is opened. Initial JS drops from 573 KB (178 KB gzip) to 481 KB (157 KB gzip). Lazy chunks resolve relative to the entry module (`base: './'` + `import.meta.url`), so they work under any mount prefix; a failed chunk import (e.g. a tab left open across a rolling deploy) triggers a single page reload to pick up the new build.
