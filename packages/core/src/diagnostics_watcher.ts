import diagnostics_channel, { type Channel } from 'node:diagnostics_channel';
import {
  type DiagnosticEvent,
  getDiagnosticsRegistry,
  isDiagnosticEvent,
} from './diagnostics_registry.js';
import { EntryType, type RecordInput } from './entry.js';
import type { TelescopeStore } from './store.js';

/** Telescope entry `type` produced by this watcher. */
export const DIAGNOSTIC_ENTRY_TYPE = EntryType.Diagnostic;

/**
 * What a single recorded diagnostic entry looks like. Mirrors the
 * {@link DiagnosticEvent} envelope, with the library-defined data preserved
 * verbatim under `payload`.
 */
export interface DiagnosticEntryContent {
  /** Envelope schema version, or `null` on a legacy (pre-versioning) envelope. */
  v: number | null;
  /** The emitting library, e.g. `'billing'`. */
  lib: string;
  /** The event within that library, e.g. `'invoice-paid'`. */
  event: string;
  /** Epoch millis the producer stamped the event with. */
  ts: number;
  /** The trace id the producer resolved, or `null` when none. */
  traceId: string | null;
  /** The library-defined payload, recorded as-is. */
  payload: unknown;
}

/**
 * The ONE generic watcher behind `@agora/telescope`'s diagnostics integration. It
 * records every event any `@agora/*` library emits through `@agora/diagnostics` —
 * one `diagnostic` entry per `agora:<lib>:<event>` publish — without a bespoke
 * watcher per library. This is the Agora equivalent of NestJS's
 * `@dudousxd/nestjs-diagnostics-telescope` extension.
 *
 * ## Cross-repo decoupling
 * Telescope CANNOT import `@agora/diagnostics`. Instead it reads the registry
 * `@agora/diagnostics` publishes on `Symbol.for('@agora/diagnostics:registry')`
 * (`{ channels, listeners }`) and subscribes to each channel via the Node builtin
 * `node:diagnostics_channel` — no Agora import needed.
 *
 * ## How it auto-subscribes to current + future channels
 * `node:diagnostics_channel` has no wildcard, so on {@link start} the watcher:
 *  1. subscribes to every channel already in `registry.channels`, and
 *  2. adds a listener to `registry.listeners` so any channel that appears later
 *     (a library's first emit) is subscribed too.
 *
 * Subscribing also flips each producer's `channel.hasSubscribers` to `true`, which
 * is what makes the producer build + publish envelopes at all (zero-overhead when
 * nobody listens).
 */
export class DiagnosticsWatcher {
  readonly type = DIAGNOSTIC_ENTRY_TYPE;
  private started = false;
  /** The listener we added to `registry.listeners`, for exact removal on stop. */
  private registryListener: ((name: string) => void) | null = null;
  /** name → the subscribe handler we attached, so cleanup can detach exactly. */
  private readonly subscriptions = new Map<string, (msg: unknown) => void>();

  constructor(private readonly store: TelescopeStore) {}

  /**
   * Begin recording. Subscribes to every currently-registered channel and arms a
   * listener for future ones. A no-op when `@agora/diagnostics` is not loaded
   * (the registry slot is absent) — telescope degrades gracefully.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const registry = getDiagnosticsRegistry();
    if (!registry) return;

    for (const name of registry.channels) this.subscribe(name);
    const listener = (name: string) => this.subscribe(name);
    this.registryListener = listener;
    registry.listeners.add(listener);
  }

  /** Unsubscribe from every channel and stop watching for new ones. */
  stop(): void {
    if (this.registryListener) {
      getDiagnosticsRegistry()?.listeners.delete(this.registryListener);
      this.registryListener = null;
    }
    for (const [name, handler] of this.subscriptions) {
      diagnostics_channel.channel(name).unsubscribe(handler);
    }
    this.subscriptions.clear();
    this.started = false;
  }

  /** Subscribe once to `name`, recording each publish as a `diagnostic` entry. */
  private subscribe(name: string): void {
    if (this.subscriptions.has(name)) return;
    const handler = (msg: unknown) => this.safeRecord(msg);
    this.subscriptions.set(name, handler);
    const channel: Channel = diagnostics_channel.channel(name);
    channel.subscribe(handler);
  }

  /** Validate + record, swallowing any failure so a producer can never break. */
  private safeRecord(msg: unknown): void {
    try {
      if (!isDiagnosticEvent(msg)) return;
      this.store.record(buildDiagnosticEntry(msg));
    } catch (err) {
      // NOT rethrown — telescope must never break an emitting code path.
      console.error('DiagnosticsWatcher: failed to record diagnostic event:', err);
    }
  }
}

/** Map a {@link DiagnosticEvent} envelope to a Telescope {@link RecordInput}. */
export function buildDiagnosticEntry(msg: DiagnosticEvent): RecordInput<DiagnosticEntryContent> {
  const traceId = msg.traceId ?? null;
  const content: DiagnosticEntryContent = {
    // Tolerate envelopes from emitters that predate schema versioning.
    v: msg.v ?? null,
    lib: msg.lib,
    event: msg.event,
    ts: msg.ts,
    traceId,
    payload: msg.payload,
  };
  return {
    type: DIAGNOSTIC_ENTRY_TYPE,
    // Group by lib + event so a dashboard can roll up "billing:invoice-paid".
    familyHash: `${msg.lib}:${msg.event}`,
    tags: [`lib:${msg.lib}`, `event:${msg.event}`, ...(traceId ? [`trace:${traceId}`] : [])],
    content,
    // Carry the producer-resolved trace id (it knows the emitting context best).
    traceId,
  };
}
