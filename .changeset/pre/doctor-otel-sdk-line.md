---
'@adonis-agora/telescope': patch
---

`agora:doctor`'s `telescope.otel` check no longer flags `@opentelemetry/sdk-node@0.301.1` (pulled by `@adonisjs/otel` 2) as SDK 2. Experimental `0.Nxx` packages now map to SDK line N (`0.2xx` → SDK 2, `0.3xx` → SDK 3, `0.<100` → SDK 1), matching the stable `N.x` packages they pin, and any two different lines are reported as mixed.
