---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Tracing across apps. A new `propagation` block in `config/telescope.ts` makes outgoing `fetch` calls to the listed `targets` carry the W3C `traceparent` / `tracestate` (opt-in `nodeHttp` for `http.request`). Incoming `traceparent` is continued by default, without OpenTelemetry too, and `@adonisjs/queue` jobs carry the trace from dispatch to the worker. When OpenTelemetry runs, telescope leaves propagation to it. Request and job entries now record `spanId` / `parentSpanId`. On the central server, a trace that crossed several apps shows as one waterfall with an app per span, the trace list shows the apps each trace crossed, and a viewer limited to some apps sees only theirs plus "N spans in other apps hidden".
