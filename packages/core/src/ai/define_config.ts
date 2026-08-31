import type { AnthropicMessagesClient } from './telescope_ai_diagnoser.js';

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
 * Default per-diagnosis wall-clock budget the coordinator enforces (ms). A slower
 * model call loses the race and the caller (MCP tool / alert) proceeds without the
 * AI note rather than hanging.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The shape of `config/telescope_ai.ts`. The API key is sourced from the
 * environment via the host's `env.get(...)` — never hardcoded — so it stays out of
 * source control.
 */
export interface TelescopeAiConfig {
  /**
   * Master switch. When `false` (or when neither an `apiKey` nor a `client`
   * resolves), the diagnoser is a no-op: `diagnose` returns `null` and never calls
   * the API. Default `true`.
   */
  enabled?: boolean;
  /**
   * The Anthropic API key, e.g. `env.get('ANTHROPIC_API_KEY')`. When absent (and no
   * `client` is supplied) the diagnoser is effectively disabled (no-op), so the
   * package degrades safely with no key configured.
   */
  apiKey?: string;
  /**
   * A host-supplied provider — any value matching {@link AnthropicMessagesClient}.
   * When set, it is used verbatim (the `apiKey` is then ignored) so a host can wire
   * its OWN model client without this package ever constructing the Anthropic SDK.
   * This is the "provider hook" that keeps the LLM dependency optional.
   */
  client?: AnthropicMessagesClient;
  /** Claude model id. Default `claude-sonnet-4-6`. */
  model?: string;
  /** Hard cap on generated tokens per diagnosis. Default 1024. */
  maxTokens?: number;
  /**
   * How long a cached diagnosis stays fresh, in ms. Defaults to the diagnosis
   * cache's own default (24h). A family is diagnosed once, then served from cache
   * until this elapses.
   */
  cacheTtlMs?: number;
  /**
   * Per-diagnosis wall-clock timeout the coordinator enforces, in ms. `<= 0`
   * disables it. Default 8000.
   */
  timeoutMs?: number;
}

/** The fully-resolved AI config the diagnoser/coordinator act on (no optionals). */
export interface ResolvedTelescopeAiConfig {
  enabled: boolean;
  apiKey: string | null;
  /** A host-supplied provider, or `null` to construct one from `apiKey`. */
  client: AnthropicMessagesClient | null;
  model: string;
  maxTokens: number;
  /** Cache TTL override in ms, or `null` to use the cache's default. */
  cacheTtlMs: number | null;
  /** Coordinator per-diagnosis timeout in ms. */
  timeoutMs: number;
}

/**
 * Identity helper giving `config/telescope_ai.ts` full type-checking, mirroring the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import env from '#start/env'
 * import { defineConfig } from '@adonis-agora/telescope/ai'
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
  const client = config.client ?? null;
  return {
    // A configured-but-provider-less install (no key AND no client) is treated as
    // disabled so nothing ever calls a model without a way to reach one.
    enabled: (config.enabled ?? true) && (apiKey !== null || client !== null),
    apiKey,
    client,
    model: config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    cacheTtlMs:
      typeof config.cacheTtlMs === 'number' && config.cacheTtlMs > 0 ? config.cacheTtlMs : null,
    timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS };
