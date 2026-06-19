import { type Entry, EntryType, type TelescopeStore } from '@agora/telescope';
import type { Alerter } from './alerter.js';

/** Cap on entries pulled per poll — a coarse alert check never needs more. */
const POLL_SCAN_CAP = 1_000;

export interface ExceptionPollerDeps {
  store: TelescopeStore;
  alerter: Alerter;
  /** Poll cadence in ms. */
  intervalMs: number;
  /** Wall-clock seam (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Failure log sink. Defaults to `console.warn`. */
  logger?: (message: string) => void;
}

/**
 * The hook point. Telescope's headless `@agora/telescope` core does not expose a
 * "new entry" event, so — by design, to avoid modifying core — this poller reads
 * the {@link TelescopeStore} on an interval for `exception` entries recorded since
 * the previous poll (a high-water-mark on `createdAt`) and feeds them to the
 * {@link Alerter}. Polling keeps the hook fully testable (drive {@link pollOnce}
 * directly) and decoupled from any specific watcher.
 *
 * The unref'd timer means the poller never keeps the process alive on its own.
 * Every poll is wrapped so a store failure is logged, not thrown.
 */
export class ExceptionPoller {
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** High-water mark: only entries strictly newer than this are new to us. */
  private since: Date;

  constructor(private readonly deps: ExceptionPollerDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? ((message) => console.warn(message));
    // Start from "now" so we never alert on the entire pre-existing backlog at boot.
    this.since = new Date(this.now());
  }

  /** Start the unref'd poll interval. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error: unknown) => {
        this.logger(`Telescope alert poll failed: ${asMessage(error)}`);
      });
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the poll interval. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Read exception entries recorded since the last poll, advance the high-water
   * mark, and hand them to the alerter. Exposed for deterministic tests. Never
   * throws — a store failure is logged and the watermark is left untouched so the
   * next poll retries the same window.
   */
  async pollOnce(): Promise<void> {
    let entries: Entry[];
    try {
      entries = await this.deps.store.list({
        type: EntryType.Exception,
        after: this.since,
        limit: POLL_SCAN_CAP,
      });
    } catch (error: unknown) {
      this.logger(`Telescope alert poll failed: ${asMessage(error)}`);
      return;
    }

    if (entries.length > 0) {
      // `list` returns newest-first; advance the mark to the newest seen.
      const newest = entries[0];
      if (newest !== undefined) this.since = newest.createdAt;
    }

    // Feed oldest-first so occurrence ordering / first-seen detection is natural.
    await this.deps.alerter.evaluate([...entries].reverse());
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
