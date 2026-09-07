import type { Entry, RecordInput } from '../entry.js';
import { getTelescopeRuntime } from '../registry.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import { mapEntryToOtel } from './mapper.js';
import type { OtelExporter } from './otel_exporter.js';

/**
 * A {@link TelescopeStore} decorator that exports each PERSISTED entry (of a
 * configured `entryTypes`) to an OTel Collector via {@link OtelExporter}, as
 * either a span (has a duration) or a log record (point-in-time) — see
 * `mapper.ts` for the exact mapping.
 *
 * Placed in the provider's chain the SAME way {@link
 * import('../stream/streaming_store.js').StreamingTelescopeStore} is: AFTER
 * redaction and sampling, so it only ever sees the final, already-scrubbed entry
 * that actually got stored:
 *
 * - **Redaction**: `record()` delegates to `inner.record()` FIRST and exports
 *   from the RETURNED entry, never the raw input — so whatever the redacting
 *   decorator masked is what leaves the process as OTel attributes/log bodies,
 *   never the pre-redaction content. This is deliberate ordering, not an
 *   accident: exporting to an external Collector is a strictly bigger
 *   exfiltration surface than the local Telescope store, so it must never see
 *   anything the local store itself wasn't already allowed to keep.
 * - **Sampling**: a sampled-away entry comes back with `sequence: -1` (the
 *   sampling decorator's synthetic placeholder, never persisted) — skipped here
 *   exactly like `StreamingTelescopeStore` skips it, so a dropped-from-storage
 *   entry costs no OTel export either (same tail-sampling decision, no separate
 *   OTel-side sampling knob; see the `otel` docs page for why this was the
 *   chosen default over an independent rate).
 * - **Overload guard**: checked EXPLICITLY here (`getTelescopeRuntime().paused`)
 *   before doing any export work. This is IN ADDITION to whatever the ingestion
 *   entry point itself does — it guarantees that even if a producer's `paused`
 *   check has already let an entry through, no NEW export work (an OTLP HTTP
 *   call) starts while the guard has shed load. The entry is still recorded/
 *   returned normally either way; only the export side-effect is skipped.
 */
export class OtelExportingTelescopeStore implements TelescopeStore {
  private readonly entryTypes: ReadonlySet<string>;

  constructor(
    private readonly inner: TelescopeStore,
    private readonly exporter: OtelExporter,
    entryTypes: readonly string[],
  ) {
    this.entryTypes = new Set(entryTypes);
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const entry = await this.inner.record(input);
    if (entry.sequence >= 0 && this.entryTypes.has(entry.type) && !getTelescopeRuntime().paused) {
      this.export(entry as Entry);
    }
    return entry;
  }

  /** Map + export one entry, swallowing every failure — observability must never break recording. */
  private export(entry: Entry): void {
    try {
      const mapped = mapEntryToOtel(entry);
      if (mapped === null) return;
      if (mapped.kind === 'span') {
        this.exporter.exportSpan(mapped.span);
      } else {
        this.exporter.exportLog(mapped.log);
      }
    } catch (err) {
      console.error('@adonis-agora/telescope: OTel export failed for one entry:', err);
    }
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
