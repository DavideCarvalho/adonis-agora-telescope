---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": minor
---

AI spend and agent run timings are first-class, from `@adonis-agora/agent` 0.93.0's `usage.recorded` and `run.*` events.

- **AI screen** (`#/ai`, backed by `GET <path>/api/metrics/ai`): spend over a window (total, platform and estimated shares, over time, by feature / model / payer), agent runs with a queue / model / tools bar, the slowest and most expensive, a per-step breakdown linking to the run's trace, and the calls that carried no cost. When the app's agent lib predates these events, the screen says so instead of showing $0.
- **Metrics** `agora_ai_cost_usd`, `agora_ai_tokens`, `agora_ai_audio_seconds`, `agora_ai_requests` (counters) and `agora_agent_run_duration_ms`, `_queue_ms`, `_model_ms`, `_tools_ms`, `agora_agent_tool_duration_ms` (histograms). Low-cardinality attributes only (never actor, run or thread). They are fed straight from the `agora:agent:*` channels, so sampling and retention never change a count.
- **OTLP metrics**: `otel.metrics: { enabled, endpoint?, path?, headers?, exportIntervalMs? }`. It is opt-in, independent of traces/logs and can use its own endpoint. `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http` are new optional peers, imported only when it is on.
- **Prometheus scrape**: `prometheus: { enabled: true }` serves `GET <path>/metrics` behind the same guard as the JSON API. It is off by default.
- **Grafana**: an importable dashboard ships at `grafana/agora-ai-dashboard.json`.
- **Fix**: client-paged dashboard tables (Screens, Exceptions) rendered every row; they page again.
