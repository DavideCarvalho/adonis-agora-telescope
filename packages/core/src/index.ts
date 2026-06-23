/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// — entry model —
export { EntryType, isBatchOrigin } from './entry.js';
export type { BatchOrigin, BuiltinEntryType, Entry, RecordInput } from './entry.js';

// — storage —
export type { EntryQuery, TelescopeStore } from './store.js';
export { InMemoryTelescopeStore } from './stores/memory.js';
export type { InMemoryStoreOptions } from './stores/memory.js';
export {
  createTableStatements,
  createTelescopeTable,
  DEFAULT_TABLE_NAME,
  LucidTelescopeStore,
} from './stores/lucid.js';
export type {
  CreateTableOptions,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  LucidStoreOptions,
  TelescopeColumns,
} from './stores/lucid.js';
export { storage } from './stores/factory.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';

// — query API —
export { TelescopeService } from './service.js';
export type { CountBucket } from './service.js';

// — watchers —
export {
  buildDiagnosticEntry,
  DIAGNOSTIC_ENTRY_TYPE,
  DiagnosticsWatcher,
} from './diagnostics_watcher.js';
export type { DiagnosticEntryContent } from './diagnostics_watcher.js';
export { recordRequest } from './request_watcher.js';
export type {
  HttpContextLike,
  RecordRequestOptions,
  RequestEntryContent,
} from './request_watcher.js';
export {
  buildExceptionInput,
  recordException,
  recordExceptionInStore,
} from './exception_watcher.js';
export type {
  ExceptionEntryContent,
  RecordExceptionContext,
} from './exception_watcher.js';
export { exceptionFamilyHash } from './exception_family_hash.js';
export type { ExceptionFamilyParts } from './exception_family_hash.js';

// — extension SDK —
export { defineTelescopeExtension } from './extension/types.js';
export type {
  Column,
  ContainerLike,
  DashboardSection,
  DashboardSpec,
  DataBinding,
  DataProvider,
  ExtensionContext,
  ExtensionEntryType,
  LinkSpec,
  Panel,
  PanelThresholds,
  TelescopeExtension,
} from './extension/types.js';
export { ExtensionRegistry } from './extension/registry.js';

// — config —
export { defineConfig, resolveConfig } from './define_config.js';
export type {
  NPlusOneConfig,
  RedactConfig,
  ResolvedTelescopeConfig,
  StreamConfig,
  TelescopeConfig,
  WatcherName,
} from './define_config.js';

// — live-stream (SSE entry-events pub/sub) —
export { EntryEvents } from './stream/entry_events.js';
export type { EntrySubscriber, Unsubscribe } from './stream/entry_events.js';
export { StreamingTelescopeStore } from './stream/streaming_store.js';
export { DEFAULT_HEARTBEAT_MS, streamEntries } from './stream/stream_handler.js';
export type { StreamOptions, StreamSession } from './stream/stream_handler.js';

// — sampling (tail-sampling on the write path) —
export {
  isErrorEntry,
  passesSampling,
  resolveSampling,
  samplingRates,
} from './sampling/sampling.js';
export type { SamplingConfig, SamplingRule } from './sampling/sampling.js';
export { SamplingTelescopeStore } from './sampling/sampling_store.js';

// — query analysis (N+1 detection) —
export { detectNPlusOne, detectNPlusOnePatterns } from './query/n_plus_one.js';
export type {
  NPlusOneInsight,
  NPlusOnePattern,
  NPlusOnePatternOptions,
} from './query/n_plus_one.js';

// — metrics (stats / timeseries / percentiles / traces / waterfall) —
export { MetricsService } from './metrics/metrics_service.js';
export type {
  MetricsServiceOptions,
  StatsQuery,
  TimeseriesQuery,
} from './metrics/metrics_service.js';
export {
  estimateLatencyPercentiles,
  percentile,
  summarizeStats,
} from './metrics/stats.js';
export type {
  CacheStats,
  ExceptionGroupStats,
  FamilyLatency,
  LatencyPercentilesOverride,
  LatencyStats,
  StatsResult,
  StatusBreakdown,
  SummarizeStatsInput,
} from './metrics/stats.js';
export { bucketTimeseries } from './metrics/timeseries.js';
export type { TimeseriesBucket, TimeseriesReport } from './metrics/timeseries.js';
export { summarizeTraces } from './metrics/traces.js';
export type { SummarizeTracesOptions, TraceSummary } from './metrics/traces.js';
export { buildWaterfall } from './metrics/waterfall.js';
export type { Waterfall, WaterfallSpan } from './metrics/waterfall.js';
export {
  buildHistogram,
  emptyHistogram,
  estimatePercentileFromHistogram,
  HISTOGRAM_BUCKET_COUNT,
  histogramBucketIndex,
  incrementHistogram,
  LATENCY_BOUNDARIES_MS,
  mergeHistograms,
  normalizeHistogram,
  ROLLUP_BUCKET_MS,
} from './metrics/rollup.js';

// — redaction —
export {
  compileRedactSpec,
  DEFAULT_MASK,
  DEFAULT_REDACT_KEYS,
  redact,
  redactBounded,
  redactBoundedWith,
} from './redaction/redact.js';
export type {
  CompiledRedactSpec,
  RedactBoundedResult,
  RedactOptions,
} from './redaction/redact.js';
export { RedactingTelescopeStore } from './redaction/redacting_store.js';

// — runtime (advanced) —
export {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopeEntryEvents,
  setTelescopeExtensionRegistry,
  setTelescopeRuntime,
} from './registry.js';
export type { TelescopeRuntime } from './registry.js';

// — structural ecosystem readers —
export { currentTraceId, getContextAccessor } from './context_accessor.js';
export type { ContextAccessor } from './context_accessor.js';
export {
  getDiagnosticsRegistry,
  isDiagnosticEvent,
} from './diagnostics_registry.js';
export type { DiagnosticEvent, DiagnosticsRegistry } from './diagnostics_registry.js';
