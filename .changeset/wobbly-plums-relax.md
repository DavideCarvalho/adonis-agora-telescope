---
"@adonis-agora/telescope-ui": minor
---

Rebuilt the dashboard shell to match `@dudousxd/nestjs-telescope-ui`'s actual visual structure: a
left sidebar nav (with a dynamic Watchers sub-nav, including extension-contributed entry types like
`adonis-durable`'s "Workflows") replacing the top pill-tab bar, a compact single-line header
(retention indicator, `⌘K` hint, theme toggle, live status pill), monospace typography across the
whole shell instead of only numeric values, a flat black background (dropped the dotted/grid
overlay), and denser panel spacing/corner-radius.

Added the missing "Overview" landing page (stat cards, recent failures, N+1/queue/job hotspots,
throughput + by-type breakdown, and retention posture) and filled in the previously-missing
"Entries by type" and "Slow outgoing HTTP" sections on the Pulse page. No feature/API changes —
existing sections (command palette, AI diagnosis, request replay, exports, live queue manager,
live schedules, CPU flamegraph) are unchanged, just re-laid-out.
