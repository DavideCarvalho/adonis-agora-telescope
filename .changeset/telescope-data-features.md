---
'@adonis-agora/telescope': minor
---

feat: tail-sampling, N+1 detection, and metrics (stats/timeseries/percentiles/waterfall)

Three data features ported from the NestJS `nestjs-telescope` originals:

- **Tail-sampling** — a per-entry-type keep `rate` with optional `keepErrors` / `keepSlowMs` overrides, applied on the WRITE path via a `SamplingTelescopeStore` decorator so dropped entries are never persisted. The decision is a pure function with an injected RNG (deterministic in tests). Configured via `sampling` (a bare rate or per-type rules); default-off (records everything when unset).
- **N+1 detection** — read-only analysis over stored entries grouped by trace: a flat family-count (`detectNPlusOne`) and a loop-attribution detector (`detectNPlusOnePatterns`) that names the likely driving parent and ranks loops by total wasted duration. Configured via `nPlusOne: { threshold, enabled }` (default threshold 3). Exposed at `GET <path>/api/metrics/n-plus-one/:traceId`.
- **Metrics** — storage-agnostic aggregations over the store interface: per-type stats with p50/p95/p99 latency percentiles (raw nearest-rank + a histogram estimate that agrees within one bucket-width), per-type breakdowns (query family / cache / request status / exception groups), throughput timeseries, a trace list, and a per-trace span waterfall. Exposed at `GET <path>/api/metrics/stats`, `/api/metrics/timeseries`, `/api/metrics/traces`, and `/api/metrics/waterfall/:traceId`.
