/**
 * Public surface of `@adonis-agora/telescope/otel` — the PURE mapping pieces only.
 * `otel_exporter.ts` (the real `@opentelemetry/*` SDK wiring) and
 * `otel_exporting_store.ts` are intentionally NOT re-exported here: they are
 * loaded exclusively via the dynamic `import()` in `telescope_provider.ts`'s
 * `applyOtel`, so merely importing this module (or `@adonis-agora/telescope` itself)
 * never pulls in an OTel package. Import this subpath to unit-test or reuse the
 * mapping logic itself.
 */
export {
  type AttributeMap,
  type AttributeValue,
  isValidW3cTraceId,
  type LogExportInput,
  type MappedEntry,
  mapEntryToOtel,
  resolveDurationMs,
  type SpanExportInput,
} from './mapper.js';
