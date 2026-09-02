/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.13.0';

export type {
  ResolvedTelescopeAiConfig,
  TelescopeAiConfig,
} from './define_config.js';
// — config —
export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  defineConfig,
  resolveConfig,
} from './define_config.js';
export type { Diagnosis, DiagnosisConfidence, ExceptionEntryContent } from './diagnoser.js';
// — diagnosis model + parsing —
export { normalizeConfidence, parseDiagnosis } from './diagnoser.js';
export type { DiagnosisStore } from './diagnosis_cache.js';
// — cache —
export {
  DEFAULT_DIAGNOSIS_CACHE_MAX,
  DEFAULT_DIAGNOSIS_TTL_MS,
  DiagnosisCache,
} from './diagnosis_cache.js';
export type {
  DiagnoserLike,
  DiagnosisCoordinatorOptions,
  DiagnosisSummary,
} from './diagnosis_coordinator.js';
// — diagnosis coordinator (wires MCP + alerter) —
export {
  DEFAULT_TIMEOUT_MS,
  DiagnosisCoordinator,
  formatDiagnosisMarkdown,
} from './diagnosis_coordinator.js';

// — factory (constructs the real Anthropic client) —
export { createDiagnoser } from './factory.js';
export type { RelatedEntrySummary } from './prompt.js';
// — prompt —
export { buildUserPrompt, STACK_FRAME_LIMIT, SYSTEM_PROMPT } from './prompt.js';
export type {
  AnthropicMessagesClient,
  DiagnoseOptions,
  TelescopeAiDiagnoserOptions,
} from './telescope_ai_diagnoser.js';
// — diagnoser —
export { TelescopeAiDiagnoser } from './telescope_ai_diagnoser.js';
