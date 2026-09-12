---
"@adonis-agora/telescope": patch
---

Point the `DiagnosticEvent.durationMs` doc link at the OTel mapper's real path

The JSDoc on `DiagnosticEvent.durationMs` linked the OTel bridge as
`{@link ../otel/mapper.js}`. `diagnostics_registry.ts` sits in `packages/core/src/`,
so that path resolves to `packages/core/otel/mapper.js`, which does not exist — the
mapper is `packages/core/src/otel/mapper.ts`, one level down, not up. Now `./otel/mapper.js`.
