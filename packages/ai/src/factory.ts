import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedTelescopeAiConfig } from './define_config.js';
import type { DiagnosisStore } from './diagnosis_cache.js';
import { type AnthropicMessagesClient, TelescopeAiDiagnoser } from './telescope_ai_diagnoser.js';

/**
 * Build a {@link TelescopeAiDiagnoser} from a resolved config, constructing the
 * real Anthropic SDK client from `config.apiKey`. Returns `null` when AI is
 * disabled or no key resolved — so the provider can wire a no-op without callers
 * branching. A custom `cache` (e.g. Redis-backed) can be supplied for
 * cross-process diagnosis sharing.
 */
export function createDiagnoser(
  config: ResolvedTelescopeAiConfig,
  options: { cache?: DiagnosisStore; logger?: (message: string) => void } = {},
): TelescopeAiDiagnoser | null {
  if (!config.enabled || config.apiKey === null) return null;

  // The SDK's `Anthropic` instance satisfies the structural client contract.
  const client = new Anthropic({ apiKey: config.apiKey }) as unknown as AnthropicMessagesClient;

  return new TelescopeAiDiagnoser({
    client,
    model: config.model,
    maxTokens: config.maxTokens,
    enabled: true,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
