---
'@adonis-agora/telescope': patch
---

Fleet fixes:

- `restart-loop` now alerts once per looping host, so two hosts looping at the same time page twice, and each one resolves on its own.
- `entries-dropped` counts all of a new process's drops for as long as its boot is inside the window, instead of resolving on its next heartbeat.
- `check-down` no longer reads a negative down time when the sender's clock runs ahead.
- Deploys count draining instances as still running the old version, and a rollout with nothing left running is now marked complete instead of staying at 0/0.
