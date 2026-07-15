/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.5.2';

// — config —
export { defineConfig, resolveConfig, normalizePath, defaultAuthorize } from './define_config.js';
export type {
  AuthorizeHook,
  ReplayConfig,
  ResolvedTelescopeUiConfig,
  TelescopeUiConfig,
  UiCredentials,
} from './define_config.js';

// — built-in `dashboardAuth` login screen (optional; opt-in via `config/telescope_ui.ts`) —
export {
  resolveDashboardAuth,
  performLogin,
  readSession,
  sanitizeReturnTo,
  decideDashboardAuth,
  SESSION_COOKIE_NAME,
} from './auth.js';
export type {
  DashboardAuthOptions,
  ResolvedDashboardAuth,
  LoginHook,
  LoginOutcome,
  DashboardAuthDecision,
} from './auth.js';
export {
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export { renderLoginPage } from './login_page.js';
export {
  readSessionCookie,
  writeSessionCookie,
  clearSessionCookie,
  enforceDashboardAuth,
} from './dashboard_auth.js';

// — HTTP shapes (framework-light) —
export {
  RecordingResponse,
  RecordingSink,
  formatSseFrame,
  formatSseHeartbeat,
  makeRequest,
} from './http.js';
export type { SseSink, UiHttpContext, UiRequest, UiResponse } from './http.js';

// — auth guard —
export { enforceGuard, runGuard } from './guard.js';
export type { GuardResult } from './guard.js';

// — JSON API —
export { TelescopeApi, buildQuery, toSummary } from './api.js';
export type { EntrySummary } from './api.js';

// — request replay —
export {
  replayRequest,
  REPLAY_BODY_CAP,
  REPLAY_STRIPPED_HEADERS,
  REPLAY_TIMEOUT_MS,
} from './request_replay.js';
export type { ReplayOptions, ReplayResult, ReplayTransport } from './request_replay.js';

// — dashboard —
export { renderDashboard } from './dashboard.js';
