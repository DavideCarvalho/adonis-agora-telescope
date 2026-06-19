/**
 * Structural reader for the `@agora/diagnostics` channel registry — WITHOUT
 * importing it.
 *
 * `@agora/diagnostics` publishes its registry on the cross-copy-stable global slot
 * `Symbol.for('@agora/diagnostics:registry')`: `{ channels: Set<string>,
 * listeners: Set<(name: string) => void> }`. Telescope is a separate repo and
 * cannot depend on `@agora/diagnostics`, so the {@link DiagnosticsWatcher} reads
 * this slot structurally to learn the current `agora:<lib>:<event>` channel names
 * and to be notified of future ones, then subscribes to each via the Node builtin
 * `node:diagnostics_channel` (which needs no import of the Agora package).
 */

/** The registry shape `@agora/diagnostics` publishes on the global slot. */
export interface DiagnosticsRegistry {
  /** Every channel name registered so far. */
  channels: Set<string>;
  /** Listeners notified once per newly-registered channel name. */
  listeners: Set<(name: string) => void>;
}

const REGISTRY_KEY = Symbol.for('@agora/diagnostics:registry');

/**
 * The registry `@agora/diagnostics` published, or `undefined` when the package is
 * not loaded. Returned WITHOUT creating a slot — telescope only ever reads.
 */
export function getDiagnosticsRegistry(): DiagnosticsRegistry | undefined {
  return (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as DiagnosticsRegistry | undefined;
}

/**
 * The envelope `@agora/diagnostics` publishes on each channel. Defined LOCALLY
 * (mirrors `DiagnosticEvent`) so telescope validates it structurally without an
 * import. `v` may be absent on legacy envelopes; `traceId` may be absent.
 */
export interface DiagnosticEvent<TPayload = unknown> {
  /** Envelope schema version, or absent on a legacy (pre-versioning) envelope. */
  v?: number;
  /** Epoch millis the producer stamped the event with. */
  ts: number;
  /** The emitting library, e.g. `'billing'`. */
  lib: string;
  /** The event within that library, e.g. `'invoice-paid'`. */
  event: string;
  /** The trace id the producer resolved, or absent when none. */
  traceId?: string;
  /** The library-defined payload. */
  payload: TPayload;
}

/** Strict structural validation of a diagnostics envelope. */
export function isDiagnosticEvent(msg: unknown): msg is DiagnosticEvent {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.ts === 'number' &&
    typeof m.lib === 'string' &&
    typeof m.event === 'string' &&
    'payload' in m &&
    (m.traceId === undefined || typeof m.traceId === 'string') &&
    // Tolerate legacy envelopes without `v`; reject a malformed (non-number) one.
    (m.v === undefined || typeof m.v === 'number')
  );
}
