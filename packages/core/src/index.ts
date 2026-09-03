/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.17.0';

// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js';
export type {
  DiagnoserLike,
  DiagnosisCoordinatorOptions,
  DiagnosisSummary,
} from './ai/diagnosis_coordinator.js';
// — AI diagnosis coordinator (wires the MCP tool + the alerter; SDK-free) —
export {
  DiagnosisCoordinator,
  formatDiagnosisMarkdown,
} from './ai/diagnosis_coordinator.js';
// — client-error ingestion (public front-end error endpoint) —
export {
  type ClientErrorHttpContext,
  ClientErrorIngestor,
  type ClientErrorIngestorDeps,
  ClientErrorRateLimiter,
  type ClientErrorRequest,
  type ClientErrorResponse,
  type ClientErrorsConfig,
  type ClientErrorValidation,
  type ClientExceptionContent,
  DEFAULT_CLIENT_ERRORS_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_TRACKED_IPS,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  type ResolvedClientErrorsConfig,
  resolveClientErrors,
  storeRecorder,
  userIdentityTag,
  validateClientErrorBody,
} from './client_errors/index.js';
export type { ContextAccessor, UserRef } from './context_accessor.js';
// — structural ecosystem readers —
export { currentTraceId, currentUserRef, getContextAccessor } from './context_accessor.js';
export type {
  DiagnosticsConfig,
  NPlusOneConfig,
  OverloadConfig,
  PruneConfig,
  PulseConfig,
  RedactConfig,
  ResolvedTelescopeConfig,
  StreamConfig,
  TelescopeConfig,
  WatcherName,
} from './define_config.js';
// — config —
export { defineConfig, resolveConfig } from './define_config.js';
export type { DiagnosticEvent, DiagnosticsRegistry } from './diagnostics_registry.js';
export {
  getDiagnosticsRegistry,
  isDiagnosticClaimed,
  isDiagnosticEvent,
} from './diagnostics_registry.js';
export type {
  DiagnosticEntryContent,
  DiagnosticsWatcherOptions,
} from './diagnostics_watcher.js';

// — watchers —
export {
  buildDiagnosticEntry,
  DIAGNOSTIC_ENTRY_TYPE,
  DiagnosticsWatcher,
} from './diagnostics_watcher.js';
export type { BatchOrigin, BuiltinEntryType, Entry, RecordInput } from './entry.js';
// — entry model —
export { EntryType, EXCEPTION_ENTRY_TYPES, isBatchOrigin, isExceptionType } from './entry.js';
export type { ExceptionFamilyParts } from './exception_family_hash.js';
export { exceptionFamilyHash } from './exception_family_hash.js';
export type {
  ExceptionEntryContent,
  RecordExceptionContext,
} from './exception_watcher.js';
export {
  buildExceptionInput,
  recordException,
  recordExceptionInStore,
} from './exception_watcher.js';
export { ExtensionRegistry } from './extension/registry.js';
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
  ScheduleContribution,
  TelescopeExtension,
} from './extension/types.js';
// — extension SDK —
export { defineTelescopeExtension } from './extension/types.js';
export type {
  DiagnoseExceptionHook,
  JsonRpcRequest,
  McpToolName,
  McpToolSpec,
  ResolvedTelescopeMcpConfig,
  TelescopeMcpConfig,
  TelescopeMcpServerOptions,
} from './mcp/index.js';
// — MCP (Model Context Protocol) server — expose telemetry to a coding agent —
export {
  MCP_INTERNAL_ERROR,
  MCP_METHOD_NOT_FOUND,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  MCP_UNAUTHORIZED,
  TelescopeMcpServer,
} from './mcp/index.js';
export type {
  MetricsServiceOptions,
  StatsQuery,
  TimeseriesQuery,
} from './metrics/metrics_service.js';
// — metrics (stats / timeseries / percentiles / traces / waterfall) —
export { MetricsService } from './metrics/metrics_service.js';
export type {
  PulseCardName,
  PulseExceptionGroup,
  PulseHotspot,
  PulseNPlusOne,
  PulseOptions,
  PulseQuery,
  PulseRequestHealth,
  PulseServiceOptions,
  PulseSlowEntry,
  PulseSummary,
  PulseThroughput,
  PulseUserLoad,
} from './metrics/pulse.js';
export { PULSE_CARDS, PulseService, summarizePulse } from './metrics/pulse.js';
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
export type { ScreenStats, SummarizeScreensOptions } from './metrics/screens.js';
export { summarizeScreens } from './metrics/screens.js';
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
export {
  estimateLatencyPercentiles,
  percentile,
  summarizeStats,
} from './metrics/stats.js';
export type { TimeseriesBucket, TimeseriesReport } from './metrics/timeseries.js';
export { bucketTimeseries } from './metrics/timeseries.js';
export type { SummarizeTracesOptions, TraceSummary } from './metrics/traces.js';
export { summarizeTraces } from './metrics/traces.js';
export type { Waterfall, WaterfallSpan } from './metrics/waterfall.js';
export { buildWaterfall } from './metrics/waterfall.js';
// — origin scope (labels WHERE work came from; marks liveness probes) —
export type { OriginScope, OriginScopeDriver } from './origin_scope.js';
export {
  currentOrigin,
  getOriginScopeDriver,
  isHeartbeat,
  ORIGIN_SCOPE_KEY,
  resolveOrigin,
  runAsHeartbeat,
  runWithOrigin,
} from './origin_scope.js';
export type {
  EventLoopDelayMonitor,
  OverloadGuardDeps,
  OverloadLogger,
  PauseController,
  ResolvedOverloadConfig,
} from './overload_guard.js';
export { OverloadGuard } from './overload_guard.js';
export type {
  Clock,
  PruneRun,
  PrunerDeps,
  PrunerLogger,
  PruneTrigger,
  ResolvedPruneConfig,
} from './pruner.js';
// — protective infrastructure (retention pruner + overload guard) —
export { TelescopePruner } from './pruner.js';
export type {
  NPlusOneInsight,
  NPlusOnePattern,
  NPlusOnePatternOptions,
} from './query/n_plus_one.js';
// — query analysis (N+1 detection) —
export { detectNPlusOne, detectNPlusOnePatterns } from './query/n_plus_one.js';
export type {
  CompiledRedactSpec,
  RedactBoundedResult,
  RedactBounds,
  RedactOptions,
} from './redaction/redact.js';
// — redaction —
export {
  compileRedactSpec,
  DEFAULT_MASK,
  DEFAULT_REDACT_KEYS,
  redact,
  redactBounded,
  redactBoundedWith,
} from './redaction/redact.js';
export { RedactingTelescopeStore } from './redaction/redacting_store.js';
export type { TelescopeRuntime } from './registry.js';
// — runtime (advanced) —
export {
  getTelescopeRuntime,
  resetTelescopeRuntime,
  setTelescopeDiagnosisCoordinator,
  setTelescopeEntryEvents,
  setTelescopeExtensionRegistry,
  setTelescopePaused,
  setTelescopeRecordHeartbeat,
  setTelescopeRuntime,
} from './registry.js';
export type {
  CaptureRequestInfo,
  HttpContextLike,
  RecordRequestOptions,
  RequestCaptureOptions,
  RequestEnrichment,
  RequestEnrichmentResult,
  RequestEntryContent,
  RequestKind,
  ResolvedRequestCapture,
} from './request_watcher.js';
export {
  classifyRequest,
  MAX_ENRICHMENT_TAG_LENGTH,
  MAX_ENRICHMENT_TAGS,
  recordRequest,
  resolveRequestCapture,
} from './request_watcher.js';
export type { SamplingConfig, SamplingRule } from './sampling/sampling.js';
// — sampling (tail-sampling on the write path) —
export {
  isErrorEntry,
  passesSampling,
  resolveSampling,
  samplingRates,
} from './sampling/sampling.js';
export { SamplingTelescopeStore } from './sampling/sampling_store.js';
export type { CountBucket } from './service.js';
// — query API —
export { TelescopeService } from './service.js';
// — storage —
export type { EntryQuery, TelescopeStore } from './store.js';
export type {
  LucidStoreConfig,
  MemoryStoreConfig,
  StoreContext,
  StoreProvider,
} from './stores/factory.js';
export { storage } from './stores/factory.js';
export type {
  CreateTableOptions,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  LucidStoreOptions,
  TelescopeColumns,
} from './stores/lucid.js';
export {
  createTableStatements,
  createTelescopeTable,
  DEFAULT_TABLE_NAME,
  LucidTelescopeStore,
  SCHEMA_META_TABLE_NAME,
} from './stores/lucid.js';
export type { InMemoryStoreOptions } from './stores/memory.js';
export { InMemoryTelescopeStore } from './stores/memory.js';
export type { EntrySubscriber, Unsubscribe } from './stream/entry_events.js';
// — live-stream (SSE entry-events pub/sub) —
export { EntryEvents } from './stream/entry_events.js';
export type { StreamOptions, StreamSession } from './stream/stream_handler.js';
export { DEFAULT_HEARTBEAT_MS, streamEntries } from './stream/stream_handler.js';
export { StreamingTelescopeStore } from './stream/streaming_store.js';
