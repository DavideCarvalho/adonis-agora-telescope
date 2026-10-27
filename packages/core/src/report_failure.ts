/**
 * Rate-limited failure reporting for telescope's fire-and-forget record paths.
 *
 * Every watcher records on the host's hot path and reports a failed write instead of
 * throwing. When the store is broken for a while (database down, schema not created
 * yet, a permission error), that used to print one line PER ENTRY — hundreds of
 * identical lines a minute from the Redis / query watchers alone, each a synchronous
 * stderr write on the event loop that telescope is supposed to stay off of.
 *
 * Here the first occurrence of a given `source` + message is printed immediately and
 * identical repeats inside the next {@link REPORT_WINDOW_MS} are only counted; when the
 * window closes, one line reports how many repeats it folded (nothing at all when there
 * were none). Same information — every distinct failure is still reported, with its
 * count — in a bounded number of lines.
 */

/** Window during which identical failures are folded into one line. */
export const REPORT_WINDOW_MS = 60_000;

/** Distinct failure keys tracked at once; past this, new keys print unthrottled (bounds memory). */
const MAX_TRACKED = 500;

type Log = (message: string, ...extra: unknown[]) => void;

interface ReportState {
  /** Identical failures swallowed in the current window. */
  suppressed: number;
  line: string;
  log: Log;
  timer?: ReturnType<typeof setTimeout>;
}

const reports = new Map<string, ReportState>();

function closeWindow(key: string): void {
  const state = reports.get(key);
  if (state === undefined) return;
  if (state.suppressed === 0) {
    reports.delete(key);
    return;
  }
  const n = state.suppressed;
  state.suppressed = 0;
  state.log(
    `${state.line} (repeated ${n} more time${n === 1 ? '' : 's'} in the last ${REPORT_WINDOW_MS / 1000}s)`,
  );
  // Keep folding while the failure persists: one summary line per window.
  armWindow(key, state);
}

function armWindow(key: string, state: ReportState): void {
  state.timer = setTimeout(() => closeWindow(key), REPORT_WINDOW_MS);
  // Never keep the process alive just to print a summary.
  state.timer.unref?.();
}

/**
 * Print `line` through `log` unless an identical `key` is already inside its
 * {@link REPORT_WINDOW_MS} window; in that case only count it — the count is printed
 * once when the window closes. `extra` is forwarded to `log` after the line (e.g. the
 * original error object) on the first, immediate report.
 */
export function reportFailure(
  key: string,
  line: string,
  log: Log = console.error,
  ...extra: unknown[]
): void {
  const state = reports.get(key);
  if (state !== undefined) {
    state.suppressed += 1;
    state.line = line;
    return;
  }
  log(line, ...extra);
  if (reports.size >= MAX_TRACKED) return;
  const fresh: ReportState = { suppressed: 0, line, log };
  reports.set(key, fresh);
  armWindow(key, fresh);
}

/** The message of an unknown thrown value. */
export function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Forget every tracked failure and cancel pending summaries (tests). */
export function resetFailureReports(): void {
  for (const state of reports.values()) clearTimeout(state.timer);
  reports.clear();
}
