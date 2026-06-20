/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// — config —
export { defineConfig, resolveConfig, normalizePath, defaultAuthorize } from './define_config.js';
export type {
  AuthorizeHook,
  ResolvedTelescopeUiConfig,
  TelescopeUiConfig,
  UiCredentials,
} from './define_config.js';

// — HTTP shapes (framework-light) —
export { RecordingResponse, makeRequest } from './http.js';
export type { UiHttpContext, UiRequest, UiResponse } from './http.js';

// — auth guard —
export { enforceGuard, runGuard } from './guard.js';
export type { GuardResult } from './guard.js';

// — JSON API —
export { TelescopeApi, buildQuery, toSummary } from './api.js';
export type { EntrySummary } from './api.js';

// — dashboard —
export { renderDashboard } from './dashboard.js';
