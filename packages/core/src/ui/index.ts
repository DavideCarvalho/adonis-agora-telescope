/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '1.0.0-rc.9';

export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// — the built-in "access denied" page (what a browser sees on a refused page navigation) —
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
export type {
  EntrySummary,
  RetentionInfo,
  RetentionOptions,
  RetentionPruneOptions,
  RetentionSamplingRate,
} from './api.js';
// — JSON API —
export { rejectList, TelescopeApi, toSummary } from './api.js';
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';
// — the console access contract —
export { authorizeByToken } from './console_authorize.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  AuthorizeDecision,
  AuthorizeHook,
  AuthorizeResult,
  ReplayConfig,
  ResolvedTelescopeUiConfig,
  ResolveUiConfigOptions,
  TelescopeUiConfig,
} from './define_config.js';
// — config —
export {
  defineConfig,
  MISSING_AUTHORIZE_WARNING,
  normalizePath,
  resolveConfig,
} from './define_config.js';
export type { PagedTableData, TablePagination } from './ext_table.js';
// — paged extension-dashboard tables —
export { fillLinkHref, tablePagination } from './ext_table.js';
export type { GuardResult, PageGuardOptions } from './guard.js';
// — auth guard —
export { enforceGuard, enforcePageGuard, runGuard } from './guard.js';
export type { SseSink, UiHttpContext, UiRequest, UiResponse } from './http.js';
// — HTTP shapes (framework-light) —
export {
  formatSseFrame,
  formatSseHeartbeat,
  makeRequest,
  RecordingResponse,
  RecordingSink,
} from './http.js';
export type {
  EntryListOptions,
  EntryListRequest,
  TraceListRequest,
} from './list_api.js';
// — list endpoints (filter wire format + cursor paging) —
export {
  DEFAULT_LIST_SIZE,
  EntryFilter,
  EntryQueryDraft,
  encodeEntryCursor,
  encodeTraceCursor,
  entryFeedPage,
  MAX_LIST_SIZE,
  NoFilter,
  parseEntryListRequest,
  parseTraceListRequest,
  readEntryPage,
} from './list_api.js';
export type { ArmProfileBody } from './profiles_api.js';

// — CPU profiling JSON API (optional feature: @adonis-agora/telescope/cpu_profiling) —
export { ProfilesApi } from './profiles_api.js';
export type { EnqueueBody } from './queue_manager_api.js';

// — live queue manager JSON API (optional peer: @adonisjs/queue) —
export { QueueManagerApi } from './queue_manager_api.js';
export type { ReplayOptions, ReplayResult, ReplayTransport } from './request_replay.js';
// — request replay —
export {
  REPLAY_BODY_CAP,
  REPLAY_STRIPPED_HEADERS,
  REPLAY_TIMEOUT_MS,
  replayRequest,
} from './request_replay.js';
export type { LiveScheduledTask } from './schedules_api.js';
// — live schedules JSON API (registry: `registerSchedule()`) —
export { SchedulesApi } from './schedules_api.js';
