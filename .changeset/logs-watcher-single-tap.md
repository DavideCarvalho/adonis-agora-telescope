---
'@adonis-agora/telescope': patch
---

Make the `logs` watcher safe to enable from both config files.

`watchers: ['logs']` can be set in `config/telescope.ts` (where it also accepts a `logs`
options block) and in `config/telescope_watchers.ts`. With both set, the second watcher to
boot silently did nothing — and then unteed the FIRST watcher's tap on shutdown, so the
logger was left half-instrumented. It now detects that the logger is already tapped, warns
once naming both config keys, and stays fully inert: it records nothing and its `stop()`
restores only what it teed itself.
