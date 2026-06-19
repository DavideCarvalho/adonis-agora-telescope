/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// — entry model —
export { EntryType, isBatchOrigin } from './entry.js';
export type { BatchOrigin, BuiltinEntryType, Entry, RecordInput } from './entry.js';

// — storage —
export type { EntryQuery, TelescopeStore } from './store.js';
export { InMemoryTelescopeStore } from './in_memory_store.js';
export type { InMemoryStoreOptions } from './in_memory_store.js';

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

// — config —
export { defineConfig, resolveConfig } from './define_config.js';
export type {
  ResolvedTelescopeConfig,
  TelescopeConfig,
  WatcherName,
} from './define_config.js';

// — runtime (advanced) —
export {
  getTelescopeRuntime,
  resetTelescopeRuntime,
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
