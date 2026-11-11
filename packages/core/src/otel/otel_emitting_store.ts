import type { Entry, RecordInput } from '../entry.js';
import { getTelescopeRuntime } from '../registry.js';
import { type EntryQuery, forwardOptionalReads, type TelescopeStore } from '../store.js';
import type { OtelEmitter } from './global_emitter.js';
import { mapEntryToOtel } from './mapper.js';

/** Entry types that came FROM OpenTelemetry (the span processor) and never go back to it. */
const NEVER_EMITTED = new Set(['span']);

/**
 * A {@link TelescopeStore} decorator that emits each PERSISTED entry of the configured
 * `entryTypes` through the app's global OpenTelemetry providers (see `global_emitter.ts`):
 * as a span when it has a duration, as a log record otherwise.
 *
 * It sits after redaction and sampling, like the streaming decorator, so only what the local
 * store kept leaves the process, already scrubbed. A sampled-away entry (`sequence: -1`) and
 * anything recorded while the overload guard has paused ingestion emit nothing.
 *
 * The caller's OTel context is captured synchronously, before the store write is awaited, so
 * the emitted span is a child of the span that was active when the entry was recorded (the
 * request, the job) — one trace, no duplicate root.
 *
 * A `request` entry is never emitted as a span of its own: the HTTP instrumentation already
 * has one for that request, active while telescope records it. That span gets the entry id
 * instead (`telescope.entry_id`), which links it back to the entry in the dashboard.
 */
export class OtelEmittingTelescopeStore implements TelescopeStore {
  private readonly entryTypes: ReadonlySet<string>;

  constructor(
    private readonly inner: TelescopeStore,
    private readonly emitter: OtelEmitter,
    entryTypes: readonly string[],
  ) {
    this.entryTypes = new Set(entryTypes.filter((type) => !NEVER_EMITTED.has(type)));
    forwardOptionalReads(this, inner);
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const wanted = this.entryTypes.has(input.type) || input.type === 'request';
    const captured = wanted ? this.emitter.capture() : null;
    const entry = await this.inner.record(input);
    if (captured === null || entry.sequence < 0 || getTelescopeRuntime().paused) return entry;
    try {
      if (this.entryTypes.has(entry.type) && entry.type !== 'request') {
        this.emit(entry as Entry, captured);
      } else if (entry.type === 'request') {
        this.emitter.annotateActiveSpan(captured, {
          'telescope.entry_id': entry.id,
          'telescope.entry_type': entry.type,
        });
      }
    } catch (err) {
      console.error('@adonis-agora/telescope: OTel emit failed for one entry:', err);
    }
    return entry;
  }

  private emit(entry: Entry, captured: ReturnType<OtelEmitter['capture']>): void {
    const mapped = mapEntryToOtel(entry);
    if (mapped === null) return;
    if (mapped.kind === 'span') this.emitter.emitSpan(mapped.span, captured);
    else this.emitter.emitLog(mapped.log, captured);
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
