import type { Entry, RecordInput } from '../entry.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import type { EntryEvents } from './entry_events.js';

/**
 * A {@link TelescopeStore} decorator that publishes each PERSISTED entry to an
 * {@link EntryEvents} bus so the SSE route can stream it live. Placed as the
 * OUTERMOST wrap in the provider's store chain (outside redaction + sampling), so
 * it only ever sees the final, already-scrubbed entry that actually got stored —
 * never raw content, never a sampled-away entry.
 *
 * A sampled-away entry is surfaced by the sampling decorator as a synthetic
 * placeholder with `sequence: -1` (never persisted); this decorator skips
 * publishing those, so only real stored entries are streamed.
 *
 * Default-neutral and zero-overhead: when nothing is subscribed
 * (`events.subscriberCount === 0` — the dashboard is closed) `publish` is a cheap
 * no-op, so the hot write path pays nothing. Every other operation passes through
 * untouched.
 */
export class StreamingTelescopeStore implements TelescopeStore {
  constructor(
    private readonly inner: TelescopeStore,
    private readonly events: EntryEvents,
  ) {}

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const entry = await this.inner.record(input);
    // Skip the synthetic placeholder a sampling decorator returns for a dropped
    // entry (sequence -1, never persisted): stream only entries that were stored.
    if (entry.sequence >= 0) {
      this.events.publish(entry as Entry);
    }
    return entry;
  }

  get(id: string): Promise<Entry | null> {
    return this.inner.get(id);
  }

  list(query?: EntryQuery): Promise<Entry[]> {
    return this.inner.list(query);
  }

  count(): Promise<number> {
    return this.inner.count();
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.inner.prune(olderThan, keepLast);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }
}
