import type { ResolvedTelescopeAiConfig } from './define_config.js';
import { DiagnosisCache, type DiagnosisStore } from './diagnosis_cache.js';
import { type AnthropicMessagesClient, TelescopeAiDiagnoser } from './telescope_ai_diagnoser.js';

/**
 * Build a {@link TelescopeAiDiagnoser} from a resolved config. Uses the
 * host-supplied `config.client` verbatim when present (so a host can wire its own
 * provider); otherwise constructs the real Anthropic SDK client from
 * `config.apiKey`. Returns `null` when AI is disabled or neither a client nor a key
 * resolved — so the provider can wire a no-op coordinator without callers
 * branching. A custom `cache` (e.g. Redis-backed) can be supplied for
 * cross-process diagnosis sharing; otherwise an in-memory cache honouring
 * `config.cacheTtlMs` is used.
 */
export function createDiagnoser(
  config: ResolvedTelescopeAiConfig,
  options: { cache?: DiagnosisStore; logger?: (message: string) => void } = {},
): TelescopeAiDiagnoser | null {
  if (!config.enabled) return null;

  // Prefer the host-supplied provider; else build the SDK client from the key.
  let client: AnthropicMessagesClient | null = config.client;
  if (client === null) {
    if (config.apiKey === null) return null;
    client = lazyAnthropicClient(config.apiKey);
  }

  const cache =
    options.cache ??
    (config.cacheTtlMs !== null ? new DiagnosisCache({ ttlMs: config.cacheTtlMs }) : undefined);

  return new TelescopeAiDiagnoser({
    client,
    model: config.model,
    maxTokens: config.maxTokens,
    enabled: true,
    ...(cache !== undefined ? { cache } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/**
 * An {@link AnthropicMessagesClient} that imports `@anthropic-ai/sdk` (an optional
 * peer) on the first diagnosis instead of at boot. Diagnoses are rare and on demand;
 * importing the SDK eagerly cost every process that loads telescope a few MB of heap
 * and module-load time for a client most never call.
 */
function lazyAnthropicClient(apiKey: string): AnthropicMessagesClient {
  let client: Promise<AnthropicMessagesClient> | null = null;
  return {
    messages: {
      async create(body) {
        if (client === null) {
          client = import('@anthropic-ai/sdk').then(
            // The SDK's `Anthropic` instance satisfies the structural client contract.
            ({ default: Anthropic }) =>
              new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient,
          );
          // A failed import (peer missing) is retried on the next diagnosis.
          client.catch(() => {
            client = null;
          });
        }
        return (await client).messages.create(body);
      },
    },
  };
}
