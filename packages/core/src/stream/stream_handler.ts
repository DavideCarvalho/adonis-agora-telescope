import { type EntrySummary, toSummary } from '../ui/api.js';
import { formatSseFrame, formatSseHeartbeat, type SseSink } from '../ui/http.js';
import type { EntryEvents } from './entry_events.js';

/** Default keep-alive interval, mirroring the NestJS original's 15s heartbeat. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Options for {@link streamEntries}. */
export interface StreamOptions {
  /**
   * Heartbeat interval in milliseconds. A comment-only keep-alive frame is written
   * on this cadence so proxies don't reap an idle connection. Set `0` to disable.
   * Default {@link DEFAULT_HEARTBEAT_MS}.
   */
  heartbeatMs?: number;
  /**
   * Injectable timer pair so tests can drive the heartbeat deterministically (no
   * real timers / flake). Defaults to the global `setInterval`/`clearInterval`.
   */
  timer?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

/** The live handle for an open stream — call {@link StreamSession.close} to tear it down. */
export interface StreamSession {
  /** Unsubscribe from the bus and stop the heartbeat. Idempotent. */
  close: () => void;
}

/**
 * Wire an {@link EntryEvents} bus to an {@link SseSink}: subscribe, write the SSE
 * handshake, push each newly-persisted entry as an `entry` frame (the already-redacted
 * {@link EntrySummary}, matching the list API's row shape), and emit a periodic
 * heartbeat. Cleans up (unsubscribe + clear the heartbeat) when the client
 * disconnects (the sink fires its close handler) or when {@link StreamSession.close}
 * is called.
 *
 * Port of the NestJS `StreamController.stream`, reshaped from RxJS to the
 * dependency-free emitter + a raw SSE sink. Where the original coalesced
 * type-batches over a 300ms window and pushed invalidation ticks, this pushes the
 * stored entry directly (the dashboard renders it without a refetch); the 15s
 * heartbeat is preserved.
 */
export function streamEntries(
  events: EntryEvents,
  sink: SseSink,
  options: StreamOptions = {},
): StreamSession {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const timer = options.timer ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  // Open the stream: a comment line flushes headers and confirms the connection.
  sink.write(': connected\n\n');

  const unsubscribe = events.subscribe((entry) => {
    const summary: EntrySummary = toSummary(entry);
    sink.write(formatSseFrame(summary, 'entry'));
  });

  let heartbeat: unknown = null;
  if (heartbeatMs > 0) {
    heartbeat = timer.setInterval(() => sink.write(formatSseHeartbeat()), heartbeatMs);
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat !== null) timer.clearInterval(heartbeat);
  };

  // Tear down when the client disconnects.
  sink.onClose(close);

  return { close };
}
