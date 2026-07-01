/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.3.2';

// — config —
export { defineConfig, resolveConfig, normalizePath, defaultAuthorize } from './define_config.js';
export type {
  AuthorizeHook,
  ReplayConfig,
  ResolvedTelescopeUiConfig,
  TelescopeUiConfig,
  UiCredentials,
} from './define_config.js';

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
