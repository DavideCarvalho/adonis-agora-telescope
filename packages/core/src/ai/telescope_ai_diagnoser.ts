import type { Entry } from '../entry.js';
import { type Diagnosis, type ExceptionEntryContent, parseDiagnosis } from './diagnoser.js';
import { DiagnosisCache, type DiagnosisStore } from './diagnosis_cache.js';
import { buildUserPrompt, type RelatedEntrySummary, SYSTEM_PROMPT } from './prompt.js';

/**
 * The minimal slice of the Anthropic SDK client the diagnoser uses. Declared
 * structurally so tests can inject a fake without the real SDK, and so the
 * package depends on `@anthropic-ai/sdk` only as a PEER (the host owns the
 * version). The real `Anthropic` instance satisfies this shape.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(body: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: { role: 'user' | 'assistant'; content: string }[];
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

/** Options for {@link TelescopeAiDiagnoser}. */
export interface TelescopeAiDiagnoserOptions {
  /** The Anthropic SDK client (or any value matching {@link AnthropicMessagesClient}). */
  client: AnthropicMessagesClient;
  /** Claude model id (e.g. `claude-sonnet-4-6`). */
  model: string;
  /** Hard cap on generated tokens per diagnosis. */
  maxTokens: number;
  /** Whether diagnosis is active. When `false`, {@link diagnose} is a no-op. Default `true`. */
  enabled?: boolean;
  /** Pluggable cache. Defaults to an in-memory {@link DiagnosisCache}. */
  cache?: DiagnosisStore;
  /** Failure log sink. Defaults to `console.warn`. */
  logger?: (message: string) => void;
}

/** Per-call options for {@link TelescopeAiDiagnoser.diagnose}. */
export interface DiagnoseOptions {
  /**
   * Other telescope entries recorded in the same trace (queries, the request,
   * diagnostics). Summarized into the prompt as extra context. Optional.
   */
  related?: Entry[];
  /** Bypass the cache and force a fresh API call (still writes the result back). */
  force?: boolean;
}

/**
 * AI-assisted diagnosis of `exception` telescope entries via the Anthropic Claude
 * Messages API. {@link diagnose} builds a prompt from the exception entry (plus
 * any related trace entries), calls Claude, parses a structured
 * {@link Diagnosis}, and caches it by the exception's family hash so the same
 * error is never diagnosed twice.
 *
 * Safe by construction: disabled / no client → no-op (`null`); a missing family
 * hash skips caching; a model or parse failure is logged and resolves to `null`
 * rather than throwing into the caller's path.
 */
export class TelescopeAiDiagnoser {
  private readonly client: AnthropicMessagesClient;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly enabled: boolean;
  private readonly cache: DiagnosisStore;
  private readonly logger: (message: string) => void;

  constructor(options: TelescopeAiDiagnoserOptions) {
    this.client = options.client;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.enabled = options.enabled ?? true;
    this.cache = options.cache ?? new DiagnosisCache();
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  /**
   * Diagnose one exception entry. Returns the cached diagnosis when the entry's
   * family has already been diagnosed (no second API call), otherwise calls Claude
   * once and caches the result. Resolves to `null` when disabled or on any failure.
   */
  async diagnose(
    entry: Entry<ExceptionEntryContent>,
    options: DiagnoseOptions = {},
  ): Promise<Diagnosis | null> {
    if (!this.enabled) return null;

    const familyHash = entry.familyHash;
    if (familyHash !== null && options.force !== true) {
      const cached = this.cache.get(familyHash);
      if (cached !== null) return { ...cached, cached: true };
    }

    const userPrompt = buildUserPrompt(entry, summarizeRelated(options.related ?? []));

    let text: string;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      text = extractText(response);
    } catch (error: unknown) {
      this.logger(`Telescope AI: diagnosis API call failed: ${asMessage(error)}`);
      return null;
    }

    let parsed: ReturnType<typeof parseDiagnosis>;
    try {
      parsed = parseDiagnosis(text);
    } catch (error: unknown) {
      this.logger(`Telescope AI: could not parse diagnosis: ${asMessage(error)}`);
      return null;
    }

    const diagnosis: Diagnosis = {
      cause: parsed.cause,
      fix: parsed.fix,
      confidence: parsed.confidence,
      model: this.model,
      cached: false,
    };

    if (familyHash !== null) {
      // Store the un-flagged form; reads stamp `cached: true` on the way out.
      this.cache.set(familyHash, diagnosis);
    }

    return diagnosis;
  }
}

/** Concatenate the text blocks of a Messages API response. */
function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

/** Build a short, bounded summary of each related entry for the prompt. */
function summarizeRelated(related: Entry[]): RelatedEntrySummary[] {
  const summaries: RelatedEntrySummary[] = [];
  for (const entry of related) {
    if (entry.type === 'exception') continue; // the subject itself / sibling exceptions
    let summary: string;
    try {
      summary = JSON.stringify(entry.content);
    } catch {
      summary = '(uninspectable content)';
    }
    if (summary.length > 500) summary = `${summary.slice(0, 500)}…`;
    summaries.push({ type: entry.type, summary });
  }
  return summaries;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
