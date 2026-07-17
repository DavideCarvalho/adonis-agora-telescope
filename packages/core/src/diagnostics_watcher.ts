import diagnostics_channel, { type Channel } from 'node:diagnostics_channel';
import {
  type DiagnosticEvent,
  getDiagnosticsRegistry,
  isDiagnosticClaimed,
  isDiagnosticEvent,
} from './diagnostics_registry.js';
import { EntryType, type RecordInput } from './entry.js';
import type { TelescopeStore } from './store.js';

/** Telescope entry `type` produced by this watcher. */
export const DIAGNOSTIC_ENTRY_TYPE = EntryType.Diagnostic;

/** Construction options for {@link DiagnosticsWatcher}. */
export interface DiagnosticsWatcherOptions {
  /**
   * `lib:event` keys to skip recording — the exact label the "Busiest events"
   * dashboard panel shows (e.g. `'media:upload.progress'`). High-frequency
   * channels can flood the timeline; muting one here drops only its Telescope
   * entries. The event still publishes on its diagnostics channel, so other
   * subscribers (OTel, custom watchers) keep seeing it.
   */
  exclude?: readonly string[];
  /**
   * Record events whose `lib:event` key is CLAIMED by a lib-specific watcher —
   * e.g. a sibling lib's own Telescope watcher, via `claimDiagnostics` from
   * `@adonis-agora/diagnostics`. Default `false`: claimed keys are skipped here
   * because the claiming lib already records them as a typed entry, and recording
   * them again would duplicate every such event (once typed, once as a generic
   * `diagnostic` entry). Set `true` to record everything regardless of claims,
   * e.g. to see the raw feed alongside the typed one while debugging. Independent
   * of `exclude`: `exclude` mutes noisy events outright; `recordClaimed` only
   * concerns events another watcher already records.
   */
  recordClaimed?: boolean;
}

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
 * The ONE generic watcher behind `@adonis-agora/telescope`'s diagnostics integration. It
 * records every event any `@adonis-agora/*` library emits through `@adonis-agora/diagnostics` —
 * one `diagnostic` entry per `agora:<lib>:<event>` publish — without a bespoke
 * watcher per library. This is the Agora equivalent of NestJS's
 * `@dudousxd/nestjs-diagnostics-telescope` extension.
 *
 * ## Cross-repo decoupling
 * Telescope CANNOT import `@adonis-agora/diagnostics`. Instead it reads the registry
 * `@adonis-agora/diagnostics` publishes on `Symbol.for('@agora/diagnostics:registry')`
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
  /** `lib:event` keys whose events are dropped instead of recorded. */
  private readonly excluded: ReadonlySet<string>;
  /** See {@link DiagnosticsWatcherOptions.recordClaimed}. */
  private readonly recordClaimed: boolean;

  constructor(
    private readonly store: TelescopeStore,
    options: DiagnosticsWatcherOptions = {},
  ) {
    this.excluded = new Set(options.exclude ?? []);
    this.recordClaimed = options.recordClaimed ?? false;
  }

  /**
   * Begin recording. Subscribes to every currently-registered channel and arms a
   * listener for future ones. A no-op when `@adonis-agora/diagnostics` is not loaded
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
      // Mute high-frequency channels the host opted out of. The event still
      // published on its diagnostics channel — only its Telescope entry is dropped.
      if (this.excluded.has(`${msg.lib}:${msg.event}`)) return;
      // Skip keys a lib-specific watcher already records as a typed entry, so an
      // event is never recorded twice. Checked at RECORD time (not subscribe time)
      // so claiming stays order-independent — see isDiagnosticClaimed's contract.
      if (!this.recordClaimed && isDiagnosticClaimed(msg.lib, msg.event)) return;
      // This runs inside a synchronous `node:diagnostics_channel` subscriber, so we
      // CANNOT await the now-async store. Fire-and-forget and swallow rejections —
      // telescope must never break (or block) an emitting code path.
      void this.store.record(buildDiagnosticEntry(msg)).catch((err) => {
        console.error('DiagnosticsWatcher: failed to record diagnostic event:', err);
      });
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
