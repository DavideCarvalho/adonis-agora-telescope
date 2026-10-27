---
"@adonis-agora/telescope": minor
---

Support OpenTelemetry JS 3 and `@anthropic-ai/sdk` 1.x, alongside the versions already supported.

- Peer ranges: `@opentelemetry/resources` `^2.0.0 || ^3.0.0`, `@opentelemetry/sdk-logs`
  `>=0.220.0 <1.0.0 || ^3.0.0`, `@anthropic-ai/sdk` `>=0.32.0 <2.0.0`. The `0.300.x` OTLP
  exporters and `@opentelemetry/api` 1.10 were already in range.
- New optional peer `@opentelemetry/sdk-trace` (`^2.9.0 || ^3.0.0`). OTel JS 3 has no
  `@opentelemetry/sdk-trace-base`: it was deprecated in favour of `sdk-trace`, which renames
  `BasicTracerProvider` to `TracerProvider` and takes `new BatchSpanProcessor({ exporter })`. OTel
  export loads `sdk-trace` when it is installed and falls back to `sdk-trace-base` 2.x otherwise,
  so a host that has only `sdk-trace-base` keeps exporting without changing its dependencies.
- `@opentelemetry/sdk-logs` 0.200–0.219 is no longer in the peer range. Those versions take
  `new BatchLogRecordProcessor(exporter)` while telescope passes `{ exporter }`, so on them no log
  record was ever exported.
