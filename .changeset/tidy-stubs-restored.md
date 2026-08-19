---
'@adonis-agora/telescope': patch
---

Restore the seven `config/*.stub` files, which shipped empty.

Every config stub the package publishes — `telescope.stub`, `telescope_watchers.stub`,
`telescope_ui.stub`, `telescope_ai.stub`, `telescope_alerts.stub`, `telescope_mcp.stub` and
`telescope_cpu_profiling.stub` — was a zero-byte file in the published tarball, so
`node ace add @adonis-agora/telescope` wrote an EMPTY `config/telescope.ts` (and an empty file
for each feature you selected) into your app. Only the migration stub had content.

The stubs are rebuilt from the current config surface, including everything that landed since
they were lost: the `logs` watcher and its `logs` block, `diagnostics.exclude` /
`diagnostics.recordClaimed`, `requestCapture`, `redact.perType`, `sampling`, `nPlusOne`, `pulse`,
`clientErrors`, `dashboardAuth`, `cpuProfiling.armEnabled`, `queueActions`, `queueManager`, the
`every-exception` and `metric-threshold` alert rules, `alerts.geoLookup`, and the whole
`telescope_cpu_profiling` config. A test now fails the build if any shipped stub is empty, lacks
its `exports(...)` header, or carries a backtick in its body — the defect that emptied them.
