/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.8.3';

// — diagnoser —
export { TelescopeAiDiagnoser } from './telescope_ai_diagnoser.js';
export type {
  AnthropicMessagesClient,
  DiagnoseOptions,
  TelescopeAiDiagnoserOptions,
} from './telescope_ai_diagnoser.js';

// — diagnosis model + parsing —
export { normalizeConfidence, parseDiagnosis } from './diagnoser.js';
export type { Diagnosis, DiagnosisConfidence, ExceptionEntryContent } from './diagnoser.js';

// — cache —
export {
  DEFAULT_DIAGNOSIS_CACHE_MAX,
  DEFAULT_DIAGNOSIS_TTL_MS,
  DiagnosisCache,
} from './diagnosis_cache.js';
export type { DiagnosisStore } from './diagnosis_cache.js';

// — prompt —
export { buildUserPrompt, STACK_FRAME_LIMIT, SYSTEM_PROMPT } from './prompt.js';
export type { RelatedEntrySummary } from './prompt.js';

// — factory (constructs the real Anthropic client) —
export { createDiagnoser } from './factory.js';

// — diagnosis coordinator (wires MCP + alerter) —
export {
  DEFAULT_TIMEOUT_MS,
  DiagnosisCoordinator,
  formatDiagnosisMarkdown,
} from './diagnosis_coordinator.js';
export type {
  DiagnoserLike,
  DiagnosisCoordinatorOptions,
  DiagnosisSummary,
} from './diagnosis_coordinator.js';

// — config —
export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  defineConfig,
  resolveConfig,
} from './define_config.js';
export type {
  ResolvedTelescopeAiConfig,
  TelescopeAiConfig,
} from './define_config.js';
