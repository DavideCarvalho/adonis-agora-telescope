import type { Entry } from '../entry.js';
import { isErrorEntry } from '../sampling/sampling.js';

/**
 * The generic diagnostics-entry → OTel mapper. Pure, dependency-free (no
 * `@opentelemetry/*` import anywhere in this file) so it is trivially unit-testable
 * and so importing it never pulls in the OTel SDK — only `otel_exporter.ts` (which
 * consumes this module's OUTPUT) does that, and only when OTel export is enabled.
 *
 * ## The mapping, in one paragraph
 *
 * Every recorded entry already carries a uniform shape (`type`, `content`, `tags`,
 * `durationMs`, `traceId`, `createdAt` — see `entry.ts`). This module turns that
 * shape into either a {@link SpanExportInput} or a {@link LogExportInput}:
 *
 * - **Has a duration → SPAN.** {@link resolveDurationMs} looks for it in two
 *   places: the entry's own top-level `durationMs` (set for every `diagnostic`
 *   entry whose envelope carried `@adonis-agora/diagnostics`'s `emit(..., {
 *   durationMs })`), or — when absent — a numeric `payload.durationMs` field
 *   (the convention several libs use when they stuff a richer lifecycle-event
 *   object as the payload; `@adonis-agora/durable`'s diagnostics bridge is exactly
 *   this: `emit('durable', event.type, event)` with `event.durationMs` inside).
 *   The span's start time is reconstructed as `end - durationMs` (the event is
 *   ALREADY FINISHED by the time telescope observes it — there is no live span to
 *   attach to, only a historical record — the same reconstruction
 *   `@adonis-agora/durable`'s bespoke `attachDurableOtel` uses for its step spans).
 * - **No duration → LOG.** A point-in-time occurrence becomes an OTel log record
 *   instead of a zero-duration span, which is both more idiomatic (Loki, not
 *   Tempo, is where "something happened" belongs) and cheaper (one log record vs.
 *   a full span with an implicit trace).
 *
 * Both forms share: a name/body of `agora.<lib>.<event>` (matching the naming
 * `@adonis-agora/diagnostics`'s OWN OTel bridge uses for the SAME channels, so a
 * host running both sees consistent naming), flattened scalar/array payload
 * fields as `agora.payload.<key>` attributes, `agora.lib`/`agora.event` attributes,
 * `agora.entry_id` (the Telescope entry id, so a span/log in Grafana links back to
 * the exact entry in the Telescope dashboard), and error detection reusing the
 * SAME `isErrorEntry` heuristic the sampling store already uses for `keepErrors`
 * (kept consistent on purpose: "this looks like an error" should mean the same
 * thing everywhere in this package) plus a couple of diagnostics-specific
 * additions (`payload.error` truthy, or an event name containing `error`/`fail`)
 * that `isErrorEntry` cannot see because it only reads shallow, entry-type-generic
 * fields.
 *
 * ## Trace correlation
 *
 * `entry.traceId` is the trace id `@adonis-agora/context` resolved at record time —
 * either a fresh random 16-byte value, or (when the inbound HTTP request carried
 * one) the EXACT W3C `traceparent` trace-id, parsed byte-for-byte. When it is
 * present AND well-formed (32 lowercase hex chars, not all-zero — see
 * {@link isValidW3cTraceId}), the mapper carries it through so the exporter can
 * parent the reconstructed span/log under it — the same correlation id a real
 * OTel span from an instrumented gateway upstream would have used, so Tempo/Loki
 * group them into the SAME trace even though telescope's span was synthesized
 * after the fact from a diagnostics event, not from a live OTel context.
 */

/**
 * An OTel attribute value: a primitive, or a HOMOGENEOUS array of one primitive
 * type — matching `@opentelemetry/api`'s own `AttributeValue` exactly (a mixed
 * `(string | number)[]` array is not a valid OTel attribute value), so a caller
 * can pass this straight through to `Span.setAttribute`/`startSpan({ attributes })`
 * with no cast.
 */
export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

/** A flat attribute bag — every key namespaced `agora.*` by the builders below. */
export type AttributeMap = Record<string, AttributeValue>;

/** The pure, OTel-SDK-agnostic description of one reconstructed span. */
export interface SpanExportInput {
  /** `agora.<lib>.<event>`. */
  name: string;
  /** Epoch millis the operation started (`endTimeMs - durationMs`). */
  startTimeMs: number;
  /** Epoch millis the operation completed (the entry's timestamp). */
  endTimeMs: number;
  attributes: AttributeMap;
  status: 'OK' | 'ERROR';
  /** Present only when {@link status} is `'ERROR'`. */
  errorMessage?: string;
  /** A valid W3C trace id to parent the span under, or `null` when unavailable. */
  traceId: string | null;
}

/** The pure, OTel-SDK-agnostic description of one log record. */
export interface LogExportInput {
  /** `agora.<lib>.<event>`. */
  body: string;
  /** Epoch millis the event occurred. */
  timestampMs: number;
  /** OTel numeric severity (`SeverityNumber` values — kept as a literal so this file needs no OTel import). */
  severityNumber: number;
  severityText: 'INFO' | 'WARN' | 'ERROR';
  attributes: AttributeMap;
  traceId: string | null;
}

/** Discriminated mapper result. `null` when the entry has no interpretable shape. */
export type MappedEntry =
  | { kind: 'span'; span: SpanExportInput }
  | { kind: 'log'; log: LogExportInput }
  | null;

const SEVERITY_NUMBER: Record<'INFO' | 'WARN' | 'ERROR', number> = {
  // Mirrors `@opentelemetry/api-logs`' `SeverityNumber` enum values exactly
  // (INFO=9, WARN=13, ERROR=17) without importing the package — this file must
  // stay dependency-free. `otel_exporter.ts` only ever reads these as opaque
  // numbers it forwards verbatim to the real `LogRecord`.
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);

/** Whether `id` is a well-formed, non-zero W3C trace id (32 lowercase hex chars). */
export function isValidW3cTraceId(id: string | null | undefined): id is string {
  return typeof id === 'string' && W3C_TRACE_ID_RE.test(id) && id !== ALL_ZERO_TRACE_ID;
}

/** Best-effort read of a positive, finite numeric field off an unknown value. */
function readPositiveNumber(value: unknown, key: string): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Resolve the duration this entry describes, in ms, or `null` when it is a
 * point-in-time occurrence with no associated duration. Checks the entry's own
 * top-level `durationMs` first (the standard, entry-type-generic field every
 * watcher can set — see `entry.ts`), falling back to a numeric
 * `content.payload.durationMs` (the convention a diagnostics-bridged lifecycle
 * event, e.g. `@adonis-agora/durable`'s, uses instead).
 */
export function resolveDurationMs(entry: Entry): number | null {
  if (typeof entry.durationMs === 'number' && entry.durationMs >= 0) return entry.durationMs;
  const content = entry.content as { payload?: unknown } | null | undefined;
  return readPositiveNumber(content?.payload, 'durationMs');
}

/**
 * True when `value` is a valid OTel attribute value: a primitive, or a
 * HOMOGENEOUS array of one primitive type (nulls/undefined allowed as array
 * holes, matching `@opentelemetry/api`'s own `AttributeValue`). A mixed-type
 * array (`[1, 'a']`) is rejected — it has no valid OTel representation.
 */
function isAttributeValue(value: unknown): value is AttributeValue {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(value)) {
    const types = new Set(value.filter((v) => v !== null && v !== undefined).map((v) => typeof v));
    if (types.size > 1) return false;
    const [only] = types;
    return only === undefined || only === 'string' || only === 'number' || only === 'boolean';
  }
  return false;
}

/**
 * Flatten a payload's own enumerable scalar/array fields into namespaced
 * `agora.payload.<key>` attributes. Best-effort and bounded to the payload's OWN
 * keys (one level — this is attribute flattening for search/filter, not a full
 * structural dump; the complete payload is still visible in the Telescope entry
 * itself via `agora.entry_id`). Never throws.
 */
function payloadAttributes(payload: unknown): AttributeMap {
  const attrs: AttributeMap = {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return attrs;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isAttributeValue(value)) attrs[`agora.payload.${key}`] = value;
  }
  return attrs;
}

/** Shallow diagnostic-entry content fields the mapper reads. */
interface DiagnosticLikeContent {
  lib?: unknown;
  event?: unknown;
  payload?: unknown;
  traceId?: unknown;
}

function asDiagnosticLike(content: unknown): DiagnosticLikeContent | null {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  return content as DiagnosticLikeContent;
}

/**
 * Whether this entry "looks like an error", for span status / log severity.
 * Layers two checks:
 *  1. {@link isErrorEntry} — the SAME shallow heuristic the sampling store's
 *     `keepErrors` already uses (`tags` has `'failed'`, `content.failed === true`,
 *     `content.statusCode >= 500`, or `content.level` is warn/error/fatal).
 *  2. Diagnostics-specific additions `isErrorEntry` cannot see: a truthy
 *     `payload.error` field (the `{ error }` shape lifecycle-event bridges commonly
 *     use, e.g. `@adonis-agora/durable`'s `EngineEvent`), or an `event` name
 *     containing `error`/`fail` (`'run.failed'`, `'step.failed'`, …).
 */
function looksLikeError(entry: Entry): boolean {
  if (isErrorEntry({ type: entry.type, content: entry.content, tags: entry.tags })) return true;
  const content = asDiagnosticLike(entry.content);
  if (content === null) return false;
  const payload = content.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    if (error !== undefined && error !== null && error !== false) return true;
  }
  if (typeof content.event === 'string') {
    const lower = content.event.toLowerCase();
    if (lower.includes('error') || lower.includes('fail')) return true;
  }
  return false;
}

/** Read an explicit log level off the payload/content, when present, normalized to our severity trio. */
function explicitSeverity(entry: Entry): 'INFO' | 'WARN' | 'ERROR' | null {
  const content = asDiagnosticLike(entry.content);
  const payload =
    content?.payload !== null && typeof content?.payload === 'object'
      ? (content.payload as Record<string, unknown>)
      : null;
  const raw = payload?.level ?? (entry.content as { level?: unknown } | null)?.level;
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase();
  if (lower === 'warn' || lower === 'warning') return 'WARN';
  if (lower === 'error' || lower === 'fatal') return 'ERROR';
  if (lower === 'info' || lower === 'debug' || lower === 'trace') return 'INFO';
  return null;
}

/**
 * Shared attribute base for both span and log mappings. `agora.trace_id` is
 * whatever `@adonis-agora/context` resolved verbatim — a plain search/filter
 * attribute, kept even when it is not valid W3C shape. This is deliberately
 * SEPARATE from `SpanExportInput.traceId`/`LogExportInput.traceId` (strictly
 * {@link isValidW3cTraceId}-checked), which is used for the actual OTel
 * parent-context correlation and must never be malformed.
 */
function baseAttributes(entry: Entry, lib: string, event: string): AttributeMap {
  const content = asDiagnosticLike(entry.content);
  return {
    'agora.lib': lib,
    'agora.event': event,
    'agora.entry_id': entry.id,
    ...(entry.traceId ? { 'agora.trace_id': entry.traceId } : {}),
    ...payloadAttributes(content?.payload),
  };
}

/**
 * Map one recorded {@link Entry} to a span or log export input, or `null` when it
 * has no interpretable `{ lib, event }` shape (only `diagnostic`-shaped content —
 * `lib`/`event` strings — is currently mapped; entries of other configured
 * `entryTypes` degrade to `null`, i.e. skipped, until they get their own mapping).
 */
export function mapEntryToOtel(entry: Entry): MappedEntry {
  const content = asDiagnosticLike(entry.content);
  if (content === null || typeof content.lib !== 'string' || typeof content.event !== 'string') {
    return null;
  }
  const { lib, event } = content;
  const name = `agora.${lib}.${event}`;
  const traceId = isValidW3cTraceId(entry.traceId) ? entry.traceId : null;
  const errored = looksLikeError(entry);

  const durationMs = resolveDurationMs(entry);
  const ts =
    typeof (content as { ts?: unknown }).ts === 'number' ? (content as { ts: number }).ts : null;
  if (durationMs !== null) {
    const endTimeMs = ts ?? entry.createdAt.getTime();
    const span: SpanExportInput = {
      name,
      startTimeMs: endTimeMs - durationMs,
      endTimeMs,
      attributes: baseAttributes(entry, lib, event),
      status: errored ? 'ERROR' : 'OK',
      ...(errored ? { errorMessage: errorMessageOf(content) ?? `${name} failed` } : {}),
      traceId,
    };
    return { kind: 'span', span };
  }

  const severity = explicitSeverity(entry) ?? (errored ? 'ERROR' : 'INFO');
  const log: LogExportInput = {
    body: name,
    timestampMs: ts ?? entry.createdAt.getTime(),
    severityNumber: SEVERITY_NUMBER[severity],
    severityText: severity,
    attributes: baseAttributes(entry, lib, event),
    traceId,
  };
  return { kind: 'log', log };
}

/** Best-effort extraction of a human-readable error message from a diagnostic payload. */
function errorMessageOf(content: DiagnosticLikeContent): string | undefined {
  const payload = content.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (error instanceof Error) return error.message;
  if (error !== undefined && error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  if (typeof error === 'string') return error;
  return undefined;
}
