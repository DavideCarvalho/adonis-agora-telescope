---
'@adonis-agora/telescope': minor
---

feat: wire AI exception diagnosis into the dashboard API + expose retention/sampling posture

- **AI exception diagnosis**: a new `POST <path>/api/exceptions/:id/diagnose` route (optional `?force=true` to bypass the cache) re-diagnoses (or serves the cached diagnosis for) an `exception`/`client_exception` entry via the existing `DiagnosisCoordinator`. Degrades to a clear "not configured" response when `@adonis-agora/telescope/ai` isn't installed/configured — the coordinator itself was already published in 0.5.0, this just exposes it through the UI API for the first time.
- **Retention indicator**: a new `GET <path>/api/retention` route echoes the resolved pruner cutoff (age / optional keep-last floor / cycle interval) and which entry types are being tail-sampled below 100%, so the dashboard can show a static "what's being kept" summary. No live pruner run-history — that stays a per-process runtime handle (`TelescopePruner.getRuns()`) for hosts that want it directly.
- `GET <path>/api/meta` now always registers (previously gated behind an extension registry booting) and reports `ai.enabled` / `profiling.enabled` / `queueManager.enabled` flags alongside any extension-contributed `entryTypes`/`dashboards`.

Both routes are additive and read-only; no existing route or response shape changed.
