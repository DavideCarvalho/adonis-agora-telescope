import type { Entry } from '../entry.js';
import type { ExceptionEntryContent } from './diagnoser.js';

/**
 * Cap on stack frames sent to the model. The TOP frames carry the throw site and
 * the immediate callers — the highest-signal part for root-causing — while a deep
 * tail mostly burns input tokens. Clipping keeps the prompt bounded and cheap.
 */
const STACK_FRAME_LIMIT = 25;

/**
 * The system prompt. Frames the model as a senior engineer triaging a PRODUCTION
 * exception and pins the OUTPUT CONTRACT to a strict JSON object so the result is
 * machine-parseable (cause / fix / confidence) for the dashboard and any
 * downstream alerting. We ask for confidence explicitly so an operator can
 * calibrate trust — a low-confidence guess is still useful but should be read as
 * such.
 */
export const SYSTEM_PROMPT = [
  'You are a senior backend engineer triaging a production exception for a teammate',
  'in an AdonisJS application. You are given an exception (name, message, stack) and,',
  'when available, the HTTP route it came from and other telescope entries recorded',
  'in the same request trace.',
  '',
  'Respond with ONLY a single JSON object — no prose, no markdown fences — with',
  'exactly these keys:',
  '  "cause": string — two to three sentences on WHAT failed and WHY, grounded in',
  '           the message and stack. Do not restate the exception verbatim.',
  '  "fix": string — a concrete, actionable smallest-correct change. Mention a',
  '         guard/validation if the input looks malformed.',
  '  "confidence": one of "high", "medium", "low" — your confidence in the diagnosis.',
  '',
  'Do not invent file paths or framework details unsupported by the stack. If the',
  'stack is missing, reason from the message and route and lower your confidence.',
].join('\n');

/** A related (non-exception) entry summary fed into the prompt. */
export interface RelatedEntrySummary {
  type: string;
  summary: string;
}

/**
 * Assemble the USER message from an exception entry and any related trace entries.
 * Plain labelled sections (not JSON) read better for an LLM. Absent fields are
 * omitted rather than rendered as `null`, so the model isn't nudged to comment on
 * missing data.
 */
export function buildUserPrompt(
  entry: Entry<ExceptionEntryContent>,
  related: RelatedEntrySummary[] = [],
): string {
  const content = entry.content;
  const lines: string[] = [];
  lines.push(`Exception: ${content.name}: ${content.message}`);

  const routeLine = [content.method, content.url].filter((part) => part).join(' ');
  if (routeLine !== '') lines.push(`Route: ${routeLine}`);
  if (entry.traceId !== null) lines.push(`Trace: ${entry.traceId}`);

  if (typeof content.stack === 'string' && content.stack.trim() !== '') {
    lines.push('', 'Stack:', clipStack(content.stack));
  } else {
    lines.push('', 'Stack: (none captured)');
  }

  if (related.length > 0) {
    lines.push('', 'Other entries in the same trace:');
    for (const r of related) {
      lines.push(`- [${r.type}] ${r.summary}`);
    }
  }

  return lines.join('\n');
}

/** Keep at most the first {@link STACK_FRAME_LIMIT} lines of the stack. */
function clipStack(stack: string): string {
  return stack.split('\n').slice(0, STACK_FRAME_LIMIT).join('\n');
}

export { STACK_FRAME_LIMIT };
