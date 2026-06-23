import type { RecordInput } from '../entry.js';

/**
 * Tail-sampling for the WRITE path. Ported from `nestjs-telescope`'s
 * `config/sampling.ts`: a per-entry-type keep `rate` plus `keepErrors` /
 * `keepSlowMs` overrides so a host can sample noisy types aggressively while
 * never dropping the entries that matter (errors, slow operations).
 *
 * Everything here is a PURE function with an injected RNG, so the sampling
 * decision is deterministic in tests (no flaky `Math.random()` on the hot path).
 */

/** Log levels that count as an error for `keepErrors` — a `warn` / `error` /
 *  `fatal` line is exactly what you never want sampled away. */
const ERROR_LOG_LEVELS = new Set(['warn', 'error', 'fatal']);

/**
 * Tail-sampling rule for a single entry type. Keeps `rate` of the noise but
 * always retains the entries that matter — errors and slow ones.
 */
export interface SamplingRule {
  /** Base keep-rate 0–1 applied to ordinary entries of this type. */
  rate: number;
  /** When true, always keep entries that look like errors (see {@link isErrorEntry}). */
  keepErrors?: boolean;
  /** When set, always keep entries whose `durationMs` is at least this value. */
  keepSlowMs?: number;
}

/**
 * Per-type sampling configuration. Each type maps to either a bare keep-rate
 * (uniform down-sampling) or a {@link SamplingRule} object (tail-sampling: keep a
 * fraction but always retain errors / slow entries). The reserved `default` key
 * applies to every entry type that lacks a specific rate override.
 */
export type SamplingConfig = Record<string, number | SamplingRule>;

/**
 * Pragmatic, cheap structural error check used by tail-sampling's `keepErrors`.
 * Reads only shallow, already-present fields — no deep walk — so it stays on the
 * hot path. An entry "looks like an error" when:
 *  - its `tags` include `'failed'`, OR
 *  - `content.failed === true`, OR
 *  - `content.statusCode >= 500`, OR
 *  - `content.level` is `'warn'`, `'error'`, or `'fatal'` (a Log entry).
 */
export function isErrorEntry(input: RecordInput): boolean {
  if (input.tags?.includes('failed')) {
    return true;
  }
  const { content } = input;
  if (content === null || typeof content !== 'object') {
    return false;
  }
  if ('failed' in content && (content as Record<string, unknown>).failed === true) {
    return true;
  }
  if ('statusCode' in content) {
    const statusCode = (content as Record<string, unknown>).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 500) {
      return true;
    }
  }
  if ('level' in content) {
    const level = (content as Record<string, unknown>).level;
    if (typeof level === 'string' && ERROR_LOG_LEVELS.has(level)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the keep-rate for a sampling entry. Discriminated purely by `typeof`
 * — a number is a bare rate, an object is a {@link SamplingRule}.
 */
function ruleRate(rule: number | SamplingRule): number {
  return typeof rule === 'number' ? rule : rule.rate;
}

/**
 * Projects a {@link SamplingConfig} down to bare per-type keep-rates for the
 * meta/dashboard contract, which only surfaces the headline rate.
 */
export function samplingRates(sampling: SamplingConfig): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const [type, rule] of Object.entries(sampling)) {
    rates[type] = ruleRate(rule);
  }
  return rates;
}

/**
 * Tail-sampling decision for one input. Plain-number per-type config behaves
 * exactly as a uniform keep-rate. A {@link SamplingRule} additionally always
 * keeps errors (`keepErrors`) and slow entries (`durationMs >= keepSlowMs`)
 * before falling back to the base rate. `random` is the injected 0–1 source.
 *
 * Default-neutral: a type with no rule (and no `default`) is always kept, so an
 * unset `sampling` config records everything exactly as before.
 */
export function passesSampling(
  sampling: SamplingConfig,
  input: RecordInput,
  random: () => number,
): boolean {
  const rule = sampling[input.type] ?? sampling.default;
  if (rule === undefined) {
    return true;
  }

  if (typeof rule === 'object') {
    if (rule.keepErrors === true && isErrorEntry(input)) {
      return true;
    }
    if (
      rule.keepSlowMs !== undefined &&
      input.durationMs !== undefined &&
      input.durationMs !== null &&
      input.durationMs >= rule.keepSlowMs
    ) {
      return true;
    }
  }

  const rate = ruleRate(rule);
  if (rate >= 1) {
    return true;
  }
  if (rate <= 0) {
    return false;
  }
  return random() < rate;
}

/**
 * Normalize the author-facing `sampling` option (a bare number → `{ default }`,
 * or a {@link SamplingConfig} as-is, or `undefined` → `{}` meaning record
 * everything) into a {@link SamplingConfig}.
 */
export function resolveSampling(sampling?: number | SamplingConfig): SamplingConfig {
  if (sampling === undefined) return {};
  if (typeof sampling === 'number') return { default: sampling };
  return sampling;
}
