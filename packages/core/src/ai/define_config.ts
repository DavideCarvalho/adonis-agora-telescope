/**
 * Default Claude model for diagnosis. Sonnet 4.6 is the best speed/intelligence
 * balance for a short structured triage; override with a more capable model
 * (`claude-opus-4-8`) or a cheaper one (`claude-haiku-4-5-20251001`) in config.
 */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Default cap on generated tokens. The system prompt asks for a bounded JSON
 * object, but we also cap at the API level so a runaway model can't produce a
 * huge, expensive response. 1024 tokens comfortably fits cause + fix + confidence.
 */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * The shape of `config/telescope_ai.ts`. The API key is sourced from the
 * environment via the host's `env.get(...)` — never hardcoded — so it stays out of
 * source control.
 */
export interface TelescopeAiConfig {
  /**
   * Master switch. When `false` (or when no `apiKey` resolves), the diagnoser is a
   * no-op: `diagnose` returns `null` and never calls the API. Default `true`.
   */
  enabled?: boolean;
  /**
   * The Anthropic API key, e.g. `env.get('ANTHROPIC_API_KEY')`. When absent the
   * diagnoser is effectively disabled (no-op), so the package degrades safely with
   * no key configured.
   */
  apiKey?: string;
  /** Claude model id. Default `claude-sonnet-4-6`. */
  model?: string;
  /** Hard cap on generated tokens per diagnosis. Default 1024. */
  maxTokens?: number;
}

/** The fully-resolved AI config the diagnoser acts on (no optionals). */
export interface ResolvedTelescopeAiConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  maxTokens: number;
}

/**
 * Identity helper giving `config/telescope_ai.ts` full type-checking, mirroring the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import env from '#start/env'
 * import { defineConfig } from '@agora/telescope/ai'
 * export default defineConfig({ apiKey: env.get('ANTHROPIC_API_KEY') })
 * ```
 */
export function defineConfig(config: TelescopeAiConfig): TelescopeAiConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeAiConfig = {}): ResolvedTelescopeAiConfig {
  const apiKey =
    typeof config.apiKey === 'string' && config.apiKey.trim() !== '' ? config.apiKey : null;
  return {
    // A configured-but-keyless install is treated as disabled so nothing ever
    // calls the API without credentials.
    enabled: (config.enabled ?? true) && apiKey !== null,
    apiKey,
    model: config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export { DEFAULT_MODEL, DEFAULT_MAX_TOKENS };
