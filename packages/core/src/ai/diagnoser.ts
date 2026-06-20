// Re-export the canonical exception content shape from the core entry model, so
// the diagnosis types and the recorded exception entries never drift.
export type { ExceptionEntryContent } from '../exception_watcher.js';

/** A diagnosis confidence level, as returned by the model. */
export type DiagnosisConfidence = 'high' | 'medium' | 'low';

/**
 * A structured AI diagnosis of one exception family. Returned by
 * {@link TelescopeAiDiagnoser.diagnose} and cached by family hash.
 */
export interface Diagnosis {
  /** Likely root cause — what failed and why. */
  cause: string;
  /** A concrete, actionable suggested fix. */
  fix: string;
  /** The model's confidence in this diagnosis. */
  confidence: DiagnosisConfidence;
  /** The model id that produced this diagnosis. */
  model: string;
  /** Whether this result was served from the cache (vs a fresh API call). */
  cached: boolean;
}

/** Narrow an arbitrary string to a {@link DiagnosisConfidence}, defaulting to `low`. */
export function normalizeConfidence(value: unknown): DiagnosisConfidence {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'high' || v === 'medium' || v === 'low') return v;
  }
  return 'low';
}

/**
 * Parse the model's text response into a partial diagnosis ({@link cause} +
 * {@link fix} + {@link confidence}), defensively. The model is asked for a bare
 * JSON object, but it may wrap it in markdown fences or add stray prose; we
 * extract the first balanced `{...}` and tolerate missing fields. Throws only
 * when no JSON object can be located at all.
 */
export function parseDiagnosis(text: string): {
  cause: string;
  fix: string;
  confidence: DiagnosisConfidence;
} {
  const json = extractJsonObject(text);
  if (json === null) {
    throw new Error('AI diagnosis response did not contain a JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('AI diagnosis response was not valid JSON');
  }

  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

  return {
    cause: typeof record.cause === 'string' ? record.cause : '',
    fix: typeof record.fix === 'string' ? record.fix : '',
    confidence: normalizeConfidence(record.confidence),
  };
}

/**
 * Extract the first balanced top-level `{...}` from `text`, ignoring braces inside
 * strings. Returns `null` when none is found. This survives markdown fences and
 * leading/trailing prose around the JSON.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
