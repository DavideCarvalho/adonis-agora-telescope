---
"@adonis-agora/telescope": major
"@adonis-agora/telescope-ui": minor
---

Telescope works with `@adonisjs/otel` 2 in both directions, and no longer exports on its own.

**OpenTelemetry spans in the trace view.** Add `telescopeSpanProcessor()` from `@adonis-agora/telescope/otel` to `spanProcessors` in `config/otel.ts`. The spans the app's instrumentation records (pg, outgoing http, DNS, events, `@span()` methods) are stored as `span` entries and show in the trace waterfall next to Telescope's own entries. Where a Telescope watcher already records the same operation with more detail (`request`, `query`, `redis`, `http-client`), the OpenTelemetry span is skipped, along with the driver spans under it; with that watcher off, the span comes through instead. Sampling, retention, redaction and the overload guard apply, plus a per-trace cap (`maxSpansPerTrace`, default 200).

```ts
// config/otel.ts
import { defineConfig, destinations } from '@adonisjs/otel'
import { telescopeSpanProcessor } from '@adonis-agora/telescope/otel'

export default defineConfig({
  spanProcessors: [telescopeSpanProcessor()],
  destinations: { collector: destinations.otlp({ endpoint: 'http://localhost:4318' }) },
})
```

**One trace id.** When an OpenTelemetry SDK is running, every entry recorded inside a span takes that span's trace id, so Telescope entries and the app's spans share one trace.

**Breaking: Telescope's own exporter is removed.** The `otel` block's `enabled`, `endpoint`, `tracesPath`, `logsPath`, `headers`, `serviceName` and `timeoutMs`, and the `otel.metrics` endpoint object, are gone with no alias; boot fails with a pointer to the migration guide while any of them is set. When the app runs `@adonisjs/otel`, Telescope sends its entries (spans for timed entries, log records otherwise) and the AI-usage metrics through the app's global providers, so endpoint and headers live in `config/otel.ts` only. Without `@adonisjs/otel` nothing is sent; everything is still recorded locally.

`otel` now takes `{ entryTypes?, metrics? }` or `false`. `entryTypes` defaults to the types OpenTelemetry does not already trace (`diagnostic`, `exception`, `client_exception`, `job`, `scheduled_task`, `mail`, `cache`, `profile`); a `request` entry adds `telescope.entry_id` to the HTTP span instead of emitting another one. Entries other than diagnostics events are now mapped too (`telescope.<type>`, with `exception.*` attributes on exceptions).

**Peers.** `@adonisjs/otel` `^2.0.0` is a new optional peer and `@opentelemetry/api` moves to `^1.10.0`. The `@opentelemetry/sdk-trace`, `sdk-trace-base`, `sdk-logs`, `sdk-metrics`, `resources` and `exporter-*-otlp-http` peers are dropped.

The dashboard lists `span` entries as "OTel span".
