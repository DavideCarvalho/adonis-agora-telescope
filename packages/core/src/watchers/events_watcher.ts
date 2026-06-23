import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { safeRecord } from './record.js';

/**
 * The narrow structural slice of the `@adonisjs/core` Emitter this watcher needs:
 * `onAny(listener)` to observe EVERY emitted event, returning an unsubscribe
 * function (the exact contract `@adonisjs/events` ships — its emitter, built on
 * `emittery`, returns `() => void` from `onAny`). Mirrored structurally rather than
 * imported so the watcher stays unit-testable with a plain double and carries no
 * build-time coupling to a specific emitter version.
 *
 * The listener receives `(event, data)`: the event NAME (a string, or a class
 * constructor for class-based events) and the single emitted payload.
 */
export interface EmitterAnyLike {
  onAny(listener: (event: unknown, data: unknown) => unknown): () => void;
}

/** Narrow an arbitrary resolved provider to one with a usable `onAny`. */
export function hasOnAny(value: unknown): value is EmitterAnyLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { onAny?: unknown }).onAny === 'function'
  );
}

/** The recorded body of an `event` entry. */
export interface EventEntryContent {
  /** The emitted event name (string events) or class name (class-based events). */
  name: string;
  /** The single emitted payload, recorded as-is (redaction applies downstream). */
  payload: unknown;
  /** The active trace id at emit time, or `null`. */
  traceId: string | null;
}

/** Coerce an Adonis event identifier (string, or a class constructor) to a name. */
function eventName(event: unknown): string {
  if (typeof event === 'string') return event;
  if (typeof event === 'function' && typeof event.name === 'string' && event.name) {
    return event.name;
  }
  return String(event);
}

/**
 * Captures EVERY event emitted through the core `@adonisjs/core` Emitter and
 * records one `event` telescope entry per emit — the name and payload — correlated
 * to the active request via the trace id. It attaches a single wildcard listener
 * via `emitter.onAny(...)`.
 *
 * An ignore-list (constructor option, matched against the resolved event name)
 * filters out noisy or already-watched events — e.g. `'db:query'` (the Lucid query
 * watcher already records those) or `'mail:sent'`. Mirrors the filtering of the
 * NestJS `EventsWatcher` original.
 *
 * Recording is fire-and-forget and fully guarded: a telescope failure can never
 * break or block an emit.
 */
export class EventsWatcher {
  readonly type = EntryType.Event;
  private readonly ignore: Set<string>;
  private unsubscribe: (() => void) | null = null;

  constructor(ignore: string[] = DEFAULT_IGNORED_EVENTS) {
    this.ignore = new Set(ignore);
  }

  /**
   * Begin recording. A no-op when the emitter has no `onAny` (degrades gracefully
   * rather than throwing). Idempotent: a second call is ignored.
   */
  start(emitter: unknown): void {
    if (this.unsubscribe) return;
    if (!hasOnAny(emitter)) return;
    this.unsubscribe = emitter.onAny((event, data) => this.handle(event, data));
  }

  /** Detach the wildcard listener. Safe to call when never started. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handle(event: unknown, data: unknown): void {
    const name = eventName(event);
    if (this.ignore.has(name)) return;
    safeRecord(buildEventEntry(name, data), 'EventsWatcher');
  }
}

/**
 * The events the watcher ignores by default. These are emitted by Adonis surfaces
 * that already have a dedicated telescope watcher, so capturing them here would
 * double-record. A host can override the set via the constructor.
 */
export const DEFAULT_IGNORED_EVENTS: string[] = ['db:query', 'mail:sent'];

/** Map an emitted event name + payload to a telescope {@link RecordInput}. */
export function buildEventEntry(name: string, payload: unknown): RecordInput<EventEntryContent> {
  const traceId = currentTraceId();
  const content: EventEntryContent = { name, payload, traceId };
  return {
    type: EntryType.Event,
    familyHash: `event:${name}`,
    content,
    traceId,
    tags: ['event', `event:${name}`],
  };
}
