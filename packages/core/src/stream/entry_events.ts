import type { Entry } from '../entry.js';

/**
 * A subscriber notified of each newly-persisted {@link Entry}. Run synchronously
 * from {@link EntryEvents.publish}; it must not throw (the emitter swallows it
 * regardless) and should not block — the SSE route's subscriber just enqueues a
 * frame.
 */
export type EntrySubscriber = (entry: Entry) => void;

/**
 * Unsubscribe handle returned by {@link EntryEvents.subscribe}. Idempotent: calling
 * it twice is a no-op.
 */
export type Unsubscribe = () => void;

/**
 * Process-local pub/sub of "an entry was just persisted". Fed from the store's
 * write path (the {@link import('./streaming_store.js').StreamingTelescopeStore}
 * decorator) AFTER redaction + sampling, so only entries that actually got stored
 * — already scrubbed, never raw — are published. Consumed by the SSE stream route
 * to push live entries to the dashboard.
 *
 * Port of the NestJS `EntryEvents` (an RxJS `Subject`), reshaped to a dependency-free
 * synchronous emitter matching the Agora idiom (no RxJS). Stateless and best-effort:
 * `publish` never throws into the flush path, and is a cheap no-op when there are no
 * subscribers (`subscriberCount === 0`), so the hot write path pays nothing while the
 * dashboard is closed.
 */
export class EntryEvents {
  private readonly subscribers = new Set<EntrySubscriber>();

  /**
   * Register a subscriber and get back an idempotent unsubscribe handle. The SSE
   * route subscribes on connect and unsubscribes on client disconnect.
   */
  subscribe(subscriber: EntrySubscriber): Unsubscribe {
    this.subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Publish a freshly-persisted entry to every subscriber. Best-effort: a throwing
   * subscriber is isolated (logged-free swallow) so observability can never break
   * the flush path. A no-op when there are no subscribers.
   */
  publish(entry: Entry): void {
    if (this.subscribers.size === 0) return;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // observability must never break the flush
      }
    }
  }

  /** Number of active subscribers — `0` means `publish` is a cheap no-op. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Drop every subscriber (called by the provider at shutdown). */
  clear(): void {
    this.subscribers.clear();
  }
}
