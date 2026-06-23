---
"@adonis-agora/telescope": minor
---

Add exception capture. The request middleware now auto-records an `exception`
telescope entry whenever the downstream pipeline throws — error name, message,
stack, request method/url, traceId, and a stable **family hash** grouping
same-signature errors (name + message + top stack frame) — BEFORE re-throwing the
original error untouched. Recording is fire-and-forget-safe: it never swallows the
error and never lets observability break the request. This gives
`@adonis-agora/telescope-alerts` `exception` entries to fire on with zero app changes.

Also ships:

- `recordException(error, context?)` — standalone capture for non-HTTP paths
  (queue workers, ace commands, an app's `app/exceptions/handler.ts` `report()`).
  Reads the active store from the runtime slot; a no-op when telescope is not
  booted; never throws.
- `recordExceptionInStore` / `buildExceptionInput` — the pure, testable core.
- `exceptionFamilyHash` + `ExceptionFamilyParts` — the grouping-key helper
  (ported from the NestJS telescope core), exported for reuse.
- `ExceptionEntryContent` / `RecordExceptionContext` types.
