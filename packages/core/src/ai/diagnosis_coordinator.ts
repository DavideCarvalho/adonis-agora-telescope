import type { Entry } from '../entry.js';
import type { Diagnosis, ExceptionEntryContent } from './diagnoser.js';
import type { DiagnoseOptions } from './telescope_ai_diagnoser.js';

/**
 * Default per-diagnosis wall-clock budget the coordinator enforces (ms). The
 * on-demand MCP call and the alert path both wait AT MOST this long for a model
 * response; a slower diagnosis loses the race and the caller proceeds without it
 * (the underlying call keeps running and its result still lands in the cache for
 * the next reader).
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The minimal diagnoser surface the coordinator drives. {@link TelescopeAiDiagnoser}
 * satisfies it; a test injects a fake. Declared STRUCTURALLY so the coordinator —
 * and everything that imports it, including the core `index.ts` — has NO dependency
 * on the Anthropic SDK. The host supplies the concrete provider; when it supplies
 * none, `diagnoser` is `null` and the coordinator is an inert no-op.
 */
export interface DiagnoserLike {
  diagnose(
    entry: Entry<ExceptionEntryContent>,
    options?: DiagnoseOptions,
  ): Promise<Diagnosis | null>;
}

/**
 * A compact, transport-friendly projection of a {@link Diagnosis} (drops the
 * `cached` flag). This is what the alerter attaches to an alert payload, so a
 * Slack/webhook consumer sees a stable, minimal shape.
 */
export interface DiagnosisSummary {
  cause: string;
  fix: string;
  confidence: string;
  model: string;
}

/** Construction deps for {@link DiagnosisCoordinator}. */
export interface DiagnosisCoordinatorOptions {
  /**
   * The resolved diagnoser, or `null` when AI is unconfigured. When `null`,
   * {@link DiagnosisCoordinator.isConfigured} is `false` and every diagnose call
   * resolves to `null` — the feature is entirely inert with no configured provider.
   */
  diagnoser: DiagnoserLike | null;
  /** Per-diagnosis timeout in ms. `<= 0` disables the timeout. Default 8000. */
  timeoutMs?: number;
  /** Failure log sink. Defaults to `console.warn`. */
  logger?: (message: string) => void;
}

/**
 * Central AI-diagnosis coordinator — the single seam the MCP `diagnose_exception`
 * tool and the alerter's `new-exception` path both call. It owns the resolved
 * diagnoser and adds three safety properties on top of it:
 *
 *  - **Optional / lazy**: constructed with `diagnoser: null` when the host has not
 *    configured AI, in which case it is a pure no-op ({@link isConfigured} is
 *    `false` and diagnose calls return `null`). Nothing imports the LLM SDK through
 *    it — the provider supplies the concrete diagnoser.
 *  - **De-duped**: concurrent diagnose calls for the SAME exception family share one
 *    in-flight promise, so two simultaneous callers (an MCP request and an alert)
 *    never trigger two model calls. Completed diagnoses are additionally cached by
 *    the underlying diagnoser (by family hash).
 *  - **Fail-safe**: a per-call timeout bounds the wait, and ANY diagnoser failure
 *    (rejection or timeout) resolves to `null` and is logged — it NEVER throws into
 *    the host's MCP transport or alert flush path.
 */
export class DiagnosisCoordinator {
  private readonly diagnoser: DiagnoserLike | null;
  private readonly timeoutMs: number;
  private readonly logger: (message: string) => void;
  /** In-flight diagnoses keyed by family hash, so concurrent callers coalesce. */
  private readonly inFlight = new Map<string, Promise<Diagnosis | null>>();

  constructor(options: DiagnosisCoordinatorOptions) {
    this.diagnoser = options.diagnoser;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  /** Whether a real diagnoser is wired. When `false`, all diagnose calls no-op to `null`. */
  isConfigured(): boolean {
    return this.diagnoser !== null;
  }

  /**
   * Diagnose one exception entry, timeout-bounded and fail-safe. Resolves to `null`
   * when unconfigured or on any failure/timeout — NEVER throws. Concurrent calls for
   * the same family hash share a single in-flight diagnosis.
   */
  async diagnose(
    entry: Entry<ExceptionEntryContent>,
    options: DiagnoseOptions = {},
  ): Promise<Diagnosis | null> {
    const diagnoser = this.diagnoser;
    if (diagnoser === null) return null;

    const familyHash = entry.familyHash;
    if (familyHash !== null) {
      const existing = this.inFlight.get(familyHash);
      if (existing !== undefined) return existing;
    }

    const task = this.run(diagnoser, entry, options);
    if (familyHash !== null) {
      this.inFlight.set(familyHash, task);
      void task.finally(() => {
        this.inFlight.delete(familyHash);
      });
    }
    return task;
  }

  /**
   * Diagnose and render the result as markdown for the MCP `diagnose_exception`
   * tool. Returns `null` when unconfigured or on failure, so the tool degrades to
   * its "not configured / no result" message.
   */
  async diagnoseMarkdown(
    entry: Entry<ExceptionEntryContent>,
    options: DiagnoseOptions = {},
  ): Promise<string | null> {
    const diagnosis = await this.diagnose(entry, options);
    return diagnosis === null ? null : formatDiagnosisMarkdown(diagnosis);
  }

  /**
   * Diagnose and project to a compact {@link DiagnosisSummary} for the alerter to
   * attach to an alert payload. Returns `null` when unconfigured or on failure, so
   * the alert simply omits the "Probable cause (AI)" section.
   */
  async diagnoseSummary(
    entry: Entry<ExceptionEntryContent>,
    options: DiagnoseOptions = {},
  ): Promise<DiagnosisSummary | null> {
    const diagnosis = await this.diagnose(entry, options);
    if (diagnosis === null) return null;
    return {
      cause: diagnosis.cause,
      fix: diagnosis.fix,
      confidence: diagnosis.confidence,
      model: diagnosis.model,
    };
  }

  /** Run one diagnosis under the timeout, swallowing every failure to `null`. */
  private async run(
    diagnoser: DiagnoserLike,
    entry: Entry<ExceptionEntryContent>,
    options: DiagnoseOptions,
  ): Promise<Diagnosis | null> {
    try {
      return await this.withTimeout(diagnoser.diagnose(entry, options));
    } catch (error: unknown) {
      this.logger(`Telescope AI: diagnosis coordinator swallowed a failure: ${asMessage(error)}`);
      return null;
    }
  }

  /**
   * Race `promise` against the configured timeout. On timeout resolves `null`; a
   * late rejection of the underlying promise is swallowed so it never surfaces as
   * an unhandled rejection after the timer has already won.
   */
  private withTimeout(promise: Promise<Diagnosis | null>): Promise<Diagnosis | null> {
    if (!(this.timeoutMs > 0)) return promise;
    // Attach a no-op catch so a rejection that lands AFTER the timeout wins the
    // race can't become an unhandled rejection. The race still observes the
    // original promise, so a rejection BEFORE the timeout still propagates to `run`.
    promise.catch(() => undefined);
    return Promise.race([
      promise,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), this.timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}

/**
 * Render a {@link Diagnosis} as compact markdown for the MCP tool. Kept small and
 * agent-facing: a heading, a confidence/model line, the probable cause, and the
 * suggested fix.
 */
export function formatDiagnosisMarkdown(diagnosis: Diagnosis): string {
  return [
    '## Probable cause (AI diagnosis)',
    '',
    `**Confidence:** ${diagnosis.confidence} · **Model:** ${diagnosis.model}${
      diagnosis.cached ? ' · cached' : ''
    }`,
    '',
    diagnosis.cause.trim() !== '' ? diagnosis.cause : '(no cause returned)',
    '',
    '### Suggested fix',
    '',
    diagnosis.fix.trim() !== '' ? diagnosis.fix : '(no fix returned)',
  ].join('\n');
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DEFAULT_TIMEOUT_MS };
