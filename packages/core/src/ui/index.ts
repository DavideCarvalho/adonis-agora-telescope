/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.13.0';

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
export { buildQuery, TelescopeApi, toSummary } from './api.js';
export type {
  DashboardAuthDecision,
  DashboardAuthOptions,
  LoginHook,
  LoginOutcome,
  ResolvedDashboardAuth,
} from './auth.js';
// — built-in `dashboardAuth` login screen (optional; opt-in via `config/telescope_ui.ts`) —
export {
  decideDashboardAuth,
  performLogin,
  readSession,
  resolveDashboardAuth,
  SESSION_COOKIE_NAME,
  sanitizeReturnTo,
} from './auth.js';
// — dashboard auth —
export {
  clearSessionCookie,
  enforceDashboardAuth,
  readSessionCookie,
  writeSessionCookie,
} from './dashboard_auth.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  AuthorizeHook,
  ReplayConfig,
  ResolvedTelescopeUiConfig,
  TelescopeUiConfig,
  UiCredentials,
} from './define_config.js';
// — config —
export { defaultAuthorize, defineConfig, normalizePath, resolveConfig } from './define_config.js';
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
export { renderLoginPage } from './login_page.js';
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
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export {
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';
