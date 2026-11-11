import { EntryType, type RecordInput } from '../entry.js';
import { getTelescopeRuntime } from '../registry.js';
import { isTelescopeWork } from '../self_scope.js';
import { safeRecord } from '../watchers/record.js';

/**
 * `telescopeSpanProcessor()`: brings the spans the app's OpenTelemetry instrumentation
 * produces (`@adonisjs/otel` auto-instruments pg, outgoing http, DNS, events, the container,
 * your own `@span()` methods…) into telescope as `span` entries, so they show in the trace
 * waterfall next to telescope's own entries.
 *
 * Pure on purpose: no `@opentelemetry/*` import. The SDK hands every span over through the
 * structural interfaces below, so `config/otel.ts` can import this before the app boots
 * without pulling telescope's runtime or the OTel packages in.
 *
 * ## No duplicates
 *
 * Where a telescope watcher records the same operation with richer data (request bodies,
 * SQL bindings and N+1 detection, redis commands, outgoing fetch calls, emitter events), the watcher stays the
 * source and the OTel span is skipped, together with the driver spans under it (the pg query
 * under a knex query). When that watcher is off, the span comes through instead, so nothing
 * goes missing. Spans telescope itself emits are skipped too.
 *
 * ## Bounded
 *
 * Ingestion goes through the same store pipeline as every watcher: redaction, sampling,
 * retention and the overload guard apply. On top of that a trace contributes at most
 * `maxSpansPerTrace` spans, attributes are capped, and nothing is recorded before telescope
 * has booted, inside telescope's own work, or for requests to the dashboard.
 */

/** OpenTelemetry `HrTime`: seconds + nanoseconds. */
type HrTime = [number, number];

/** The slice of an SDK `ReadableSpan` the processor reads. */
export interface ReadableSpanLike {
  readonly name: string;
  readonly kind: number;
  spanContext(): { traceId: string; spanId: string };
  readonly parentSpanContext?: { spanId: string } | undefined;
  readonly startTime: HrTime;
  readonly duration: HrTime;
  readonly status: { code: number; message?: string | undefined };
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events?: ReadonlyArray<{
    name: string;
    attributes?: Readonly<Record<string, unknown>> | undefined;
  }>;
  readonly instrumentationScope?: { name: string; version?: string | undefined };
}

/** The slice of an SDK `Span` passed to `onStart`. */
export interface StartedSpanLike {
  readonly name: string;
  readonly kind: number;
  spanContext(): { traceId: string; spanId: string };
  readonly parentSpanContext?: { spanId: string } | undefined;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { name: string; version?: string | undefined };
}

/** What the SDK expects in `spanProcessors`. */
export interface TelescopeSpanProcessor {
  onStart(span: StartedSpanLike, parentContext: unknown): void;
  onEnd(span: ReadableSpanLike): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Options for {@link telescopeSpanProcessor}. */
export interface TelescopeSpanProcessorOptions {
  /** Return `true` to keep a span out of telescope. Runs after the built-in skips. */
  ignore?: (span: ReadableSpanLike) => boolean;
  /** Most spans one trace contributes. The rest of that trace is dropped. Default `200`. */
  maxSpansPerTrace?: number;
  /** Most attributes kept per span. Default `64`. */
  maxAttributes?: number;
  /** Longest string attribute value kept; longer ones are cut. Default `2048`. */
  maxAttributeLength?: number;
}

/** Content of a `span` entry. */
export interface SpanEntryContent {
  name: string;
  kind: SpanKindName;
  /** The instrumentation that produced it, e.g. `@opentelemetry/instrumentation-pg`. */
  scope: string;
  spanId: string;
  parentSpanId: string | null;
  status: 'unset' | 'ok' | 'error';
  statusMessage: string | null;
  /** `true` when the span ended with an error status. */
  failed: boolean;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
}

export type SpanKindName = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

const KIND_NAMES: readonly SpanKindName[] = [
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];
const SPAN_KIND_SERVER = 1;
const STATUS_NAMES = ['unset', 'ok', 'error'] as const;

/** The scope telescope emits its own entries under (see `global_emitter.ts`). */
const TELESCOPE_SCOPE = '@adonis-agora/telescope';

/**
 * Instrumentations a telescope watcher already covers, by scope name. `kind` narrows the match
 * (the http instrumentation makes both server and client spans; only the server side is the
 * `request` watcher's). `leaf` marks operations whose child spans are driver internals (the pg
 * query under a knex query, the socket under a redis command): those are skipped with them.
 */
const COVERED: ReadonlyArray<{ scope: string; watcher: string; kind?: number; leaf: boolean }> = [
  {
    scope: '@opentelemetry/instrumentation-http',
    kind: SPAN_KIND_SERVER,
    watcher: 'request',
    leaf: false,
  },
  { scope: '@opentelemetry/instrumentation-knex', watcher: 'query', leaf: true },
  { scope: '@opentelemetry/instrumentation-ioredis', watcher: 'redis', leaf: true },
  { scope: '@opentelemetry/instrumentation-redis', watcher: 'redis', leaf: true },
  { scope: '@opentelemetry/instrumentation-undici', watcher: 'http-client', leaf: true },
  { scope: '@adonisjs/instrumentation-events', watcher: 'events', leaf: false },
];

const MAX_EVENTS = 16;
/** How many traces / span ids the processor remembers at once (oldest forgotten first). */
const MAX_TRACKED = 4096;

/** A `Set` that forgets its oldest member past `limit`. */
class BoundedSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly limit: number) {}
  add(value: T): void {
    this.items.delete(value);
    this.items.add(value);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next();
      if (oldest.done !== true) this.items.delete(oldest.value);
    }
  }
  has(value: T): boolean {
    return this.items.has(value);
  }
  delete(value: T): void {
    this.items.delete(value);
  }
}

function scopeOf(span: { instrumentationScope?: { name: string } | undefined }): string {
  return span.instrumentationScope?.name ?? 'unknown';
}

function hrToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

/** Whether `path` is `prefix` or below it (`/telescope` covers `/telescope/api`, not `/telescopes`). */
function isUnder(path: string, prefix: string): boolean {
  const query = path.indexOf('?');
  const bare = query === -1 ? path : path.slice(0, query);
  if (bare === prefix) return true;
  return bare.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function serverPath(attributes: Readonly<Record<string, unknown>>): string | null {
  const path = attributes['url.path'] ?? attributes['http.target'];
  return typeof path === 'string' ? path : null;
}

/** Copy at most `max` attributes, cutting long strings. Values the store can't keep become strings. */
function capAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  max: number,
  maxLength: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (attributes === undefined) return out;
  let count = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (count >= max) break;
    if (value === undefined) continue;
    out[key] =
      typeof value === 'string' && value.length > maxLength
        ? `${value.slice(0, maxLength)}…`
        : value;
    count++;
  }
  return out;
}

/**
 * Build the span processor. Add it to `spanProcessors` in `config/otel.ts`:
 *
 * ```ts
 * import { defineConfig } from '@adonisjs/otel'
 * import { telescopeSpanProcessor } from '@adonis-agora/telescope/otel'
 *
 * export default defineConfig({
 *   spanProcessors: [telescopeSpanProcessor()],
 * })
 * ```
 */
export function telescopeSpanProcessor(
  options: TelescopeSpanProcessorOptions = {},
): TelescopeSpanProcessor {
  const maxSpansPerTrace = Math.max(1, options.maxSpansPerTrace ?? 200);
  const maxAttributes = Math.max(0, options.maxAttributes ?? 64);
  const maxAttributeLength = Math.max(16, options.maxAttributeLength ?? 2048);

  /** Spans skipped at start whose descendants are skipped too (driver internals, own work). */
  const skippedSpans = new BoundedSet<string>(MAX_TRACKED);
  /** Traces of requests to the dashboard. */
  const dashboardTraces = new BoundedSet<string>(MAX_TRACKED);
  /** Spans ingested so far, per trace. */
  const perTrace = new Map<string, number>();

  function coveredBy(span: StartedSpanLike | ReadableSpanLike) {
    const scope = scopeOf(span);
    const enabled = getTelescopeRuntime().enabledWatchers;
    return COVERED.find(
      (c) =>
        c.scope === scope &&
        (c.kind === undefined || c.kind === span.kind) &&
        enabled.has(c.watcher),
    );
  }

  function shouldSkip(span: ReadableSpanLike): boolean {
    const { traceId, spanId } = span.spanContext();
    if (skippedSpans.has(spanId)) {
      skippedSpans.delete(spanId);
      return true;
    }
    if (dashboardTraces.has(traceId)) {
      if (span.kind === SPAN_KIND_SERVER && span.parentSpanContext === undefined) {
        dashboardTraces.delete(traceId);
      }
      return true;
    }
    if (scopeOf(span) === TELESCOPE_SCOPE) return true;
    if (coveredBy(span) !== undefined) return true;
    if (isTelescopeWork()) return true;
    return options.ignore?.(span) === true;
  }

  function countAgainstTrace(traceId: string): boolean {
    const seen = perTrace.get(traceId) ?? 0;
    if (seen >= maxSpansPerTrace) return false;
    perTrace.delete(traceId);
    perTrace.set(traceId, seen + 1);
    if (perTrace.size > MAX_TRACKED) {
      const oldest = perTrace.keys().next();
      if (oldest.done !== true) perTrace.delete(oldest.value);
    }
    return true;
  }

  function toInput(span: ReadableSpanLike): RecordInput<SpanEntryContent> {
    const { traceId, spanId } = span.spanContext();
    const scope = scopeOf(span);
    const kind = KIND_NAMES[span.kind] ?? 'internal';
    const status = STATUS_NAMES[span.status.code] ?? 'unset';
    const failed = status === 'error';
    return {
      type: EntryType.Span,
      familyHash: `${scope}:${span.name}`,
      tags: [`scope:${scope}`, `kind:${kind}`, ...(failed ? ['failed'] : [])],
      durationMs: Math.max(0, hrToMs(span.duration)),
      traceId,
      content: {
        name: span.name,
        kind,
        scope,
        spanId,
        parentSpanId: span.parentSpanContext?.spanId ?? null,
        status,
        statusMessage: span.status.message ?? null,
        failed,
        attributes: capAttributes(span.attributes, maxAttributes, maxAttributeLength),
        events: (span.events ?? []).slice(0, MAX_EVENTS).map((event) => ({
          name: event.name,
          attributes: capAttributes(event.attributes, maxAttributes, maxAttributeLength),
        })),
      },
    };
  }

  return {
    onStart(span) {
      try {
        const runtime = getTelescopeRuntime();
        if (runtime.store === null) return;
        const { traceId, spanId } = span.spanContext();
        const parentId = span.parentSpanContext?.spanId;
        if (parentId !== undefined && skippedSpans.has(parentId)) {
          skippedSpans.add(spanId);
          return;
        }
        if (isTelescopeWork()) {
          skippedSpans.add(spanId);
          return;
        }
        if (coveredBy(span)?.leaf === true) {
          skippedSpans.add(spanId);
          return;
        }
        if (span.kind === SPAN_KIND_SERVER && runtime.selfPath !== null) {
          const path = serverPath(span.attributes);
          if (path !== null && isUnder(path, runtime.selfPath)) dashboardTraces.add(traceId);
        }
      } catch {
        // Observability never breaks the instrumented code.
      }
    },

    onEnd(span) {
      try {
        const runtime = getTelescopeRuntime();
        if (runtime.store === null || runtime.paused) return;
        if (shouldSkip(span)) return;
        if (!countAgainstTrace(span.spanContext().traceId)) return;
        safeRecord(() => toInput(span), 'telescopeSpanProcessor');
      } catch {
        // Observability never breaks the instrumented code.
      }
    },

    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
