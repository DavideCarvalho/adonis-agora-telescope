import { type Entry, EntryType } from '../entry.js';

/** The `app:<id>` of an entry recorded on a server that collects several apps. */
export function appOfEntry(entry: Pick<Entry, 'tags'>): string | undefined {
  for (const tag of entry.tags) {
    if (tag.startsWith('app:') && tag.length > 4) return tag.slice(4);
  }
  return undefined;
}

/** The span id an entry carries (`content.spanId`), or `undefined`. */
function spanIdOf(entry: Entry): string | undefined {
  const record = asRecord(entry.content);
  const id = record?.spanId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The parent span id an entry carries (`content.parentSpanId`), or `undefined`. */
function parentSpanIdOf(entry: Entry): string | undefined {
  const record = asRecord(entry.content);
  const id = record?.parentSpanId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * A single node in a trace waterfall. Offsets are relative to the trace's
 * earliest start so the UI can lay each bar out as
 * `left = offsetMs / totalDurationMs`, `width = durationMs / totalDurationMs`.
 */
export interface WaterfallSpan {
  id: string;
  type: string;
  /** A human label derived from the entry's content (route, sql, queue:job, …). */
  label: string;
  /** Start offset (ms) from the trace start. */
  offsetMs: number;
  /** Span duration (ms); a null `durationMs` becomes a zero-width instant span. */
  durationMs: number;
  /** Nesting depth (0 for roots). */
  depth: number;
  /** Stable record order within the trace (the entry's `sequence`). */
  sequence: number;
  /**
   * The app that recorded it (its `app:<id>` tag), on a server that collects several apps.
   * Absent on a single app.
   */
  app?: string;
  children: WaterfallSpan[];
}

export interface Waterfall {
  /** Absolute trace start (epoch ms) — the earliest entry start. */
  traceStartMs: number;
  /** Wall-clock span of the whole trace (latest end − earliest start), >= 0. */
  totalDurationMs: number;
  /** Root spans (those not contained by any other), ordered by start then sequence. */
  spans: WaterfallSpan[];
  /** The apps the shown spans come from (their `app:<id>` tags), in start order. Empty when no
   *  entry carries one (a single app recording for itself). */
  apps: string[];
  /**
   * Spans of this trace recorded by apps the viewer may not see: counted, never shown. Present only
   * for a viewer limited to some apps.
   */
  hiddenSpans?: number;
}

interface Interval {
  entry: Entry;
  startMs: number;
  /** Inclusive duration; null durations are treated as 0 (instant). */
  durationMs: number;
  endMs: number;
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** A human label for a span, derived from the entry's content by type. */
function labelFor(entry: Entry): string {
  const record = asRecord(entry.content);
  if (record === null) return entry.type;
  if (typeof record.url === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
  }
  if (typeof record.sql === 'string') return record.sql;
  if (typeof record.queue === 'string' && typeof record.name === 'string') {
    return `${record.queue}:${record.name}`;
  }
  if (entry.type === EntryType.HttpClient && typeof record.url === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
  }
  // Diagnostics span entries (the generic `diagnostics` watcher) carry the
  // emitting lib + event name, e.g. `agent` + `llm.turn` → "agent:llm.turn",
  // instead of falling back to the bare entry type ("diagnostic").
  if (typeof record.lib === 'string' && typeof record.event === 'string') {
    return `${record.lib}:${record.event}`;
  }
  if (typeof record.name === 'string') return record.name;
  return entry.type;
}

/**
 * Reconstruct a nested span waterfall from a trace's entries. Ported from
 * `nestjs-telescope`'s `metrics/waterfall.ts`.
 *
 * DESIGN: most entries carry `traceId` but no parent-span pointer, so — exactly as
 * Sentry/Tempo do when parent links are missing — nesting is inferred from
 * **time-interval containment**: a span is a child of the tightest enclosing span
 * whose `[start, end]` strictly contains it. `sequence` provides a stable
 * tie-break for spans that start at the same instant.
 *
 * Entries that do carry span ids (`content.spanId` / `content.parentSpanId`: requests and
 * jobs in a propagated trace, OpenTelemetry spans) are then linked explicitly, which is what
 * stitches the entries of several apps into one tree.
 *
 * Returns `null` for an empty input. Pure.
 */
export function buildWaterfall(entries: Entry[]): Waterfall | null {
  if (entries.length === 0) return null;

  const intervals: Interval[] = entries.map((entry) => {
    const durationMs = typeof entry.durationMs === 'number' ? Math.max(0, entry.durationMs) : 0;
    // `createdAt` is when the entry was RECORDED, and everything here is recorded on
    // COMPLETION: the request watcher writes in a `finally`, the redis watcher in the
    // command's `.then`, the query watcher from `db:query` after execution. So
    // `createdAt` is the span's END, and its start is that minus the duration.
    //
    // Treating it as the start shifted every span right by its own length. Short spans
    // barely moved, long ones moved a lot — which is why a 31ms request appeared AFTER
    // the 1ms redis calls it had made itself, and never enclosed them. The waterfall
    // drew a plausible picture of an impossible ordering.
    const endMs = entry.createdAt.getTime();
    return { entry, startMs: endMs - durationMs, durationMs, endMs };
  });

  const traceStartMs = Math.min(...intervals.map((i) => i.startMs));
  const traceEndMs = Math.max(...intervals.map((i) => i.endMs));
  const totalDurationMs = Math.max(0, traceEndMs - traceStartMs);

  // Order so that enclosing spans come first: earliest start, then the LONGER
  // span first (a parent starts no later and ends no earlier than its child),
  // then sequence for a stable tie-break.
  const ordered = [...intervals].sort(
    (a, b) =>
      a.startMs - b.startMs || b.durationMs - a.durationMs || a.entry.sequence - b.entry.sequence,
  );

  const nodeById = new Map<string, WaterfallSpan>();
  const roots: WaterfallSpan[] = [];
  const apps: string[] = [];
  const openStack: { interval: Interval; node: WaterfallSpan }[] = [];

  for (const interval of ordered) {
    while (openStack.length > 0) {
      const top = openStack[openStack.length - 1];
      if (top !== undefined && contains(top.interval, interval)) break;
      openStack.pop();
    }
    const parent = openStack[openStack.length - 1];
    const depth = parent === undefined ? 0 : parent.node.depth + 1;
    const app = appOfEntry(interval.entry);
    if (app !== undefined && !apps.includes(app)) apps.push(app);
    const node: WaterfallSpan = {
      id: interval.entry.id,
      type: interval.entry.type,
      label: labelFor(interval.entry),
      offsetMs: interval.startMs - traceStartMs,
      durationMs: interval.durationMs,
      depth,
      sequence: interval.entry.sequence,
      ...(app !== undefined ? { app } : {}),
      children: [],
    };
    nodeById.set(node.id, node);
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    openStack.push({ interval, node });
  }

  // Explicit links win over time containment: an entry naming its parent span (a request another
  // app called, a job a request dispatched, an OpenTelemetry span) hangs under the entry that has
  // that span id. That is what joins apps whose clocks disagree by a few ms. A link that would make
  // a cycle, or names a span not in the trace, keeps the containment parent.
  const parentOf = new Map<string, WaterfallSpan | undefined>();
  const record = (node: WaterfallSpan, parent: WaterfallSpan | undefined) => {
    parentOf.set(node.id, parent);
    for (const child of node.children) record(child, node);
  };
  for (const root of roots) record(root, undefined);
  const bySpanId = new Map<string, WaterfallSpan>();
  for (const interval of ordered) {
    const spanId = spanIdOf(interval.entry);
    const node = nodeById.get(interval.entry.id);
    if (spanId !== undefined && node !== undefined && !bySpanId.has(spanId)) {
      bySpanId.set(spanId, node);
    }
  }
  for (const interval of ordered) {
    const parentSpanId = parentSpanIdOf(interval.entry);
    if (parentSpanId === undefined) continue;
    const node = nodeById.get(interval.entry.id);
    const target = bySpanId.get(parentSpanId);
    if (node === undefined || target === undefined || target === node) continue;
    if (parentOf.get(node.id) === target) continue;
    // `target` must not sit under `node`.
    let cursor: WaterfallSpan | undefined = target;
    let cycle = false;
    while (cursor !== undefined) {
      if (cursor === node) {
        cycle = true;
        break;
      }
      cursor = parentOf.get(cursor.id);
    }
    if (cycle) continue;
    const current = parentOf.get(node.id);
    const siblings = current === undefined ? roots : current.children;
    const at = siblings.indexOf(node);
    if (at !== -1) siblings.splice(at, 1);
    target.children.push(node);
    parentOf.set(node.id, target);
  }
  const setDepth = (node: WaterfallSpan, depth: number) => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const root of roots) setDepth(root, 0);

  // Order children (and roots) by start offset, then sequence.
  const byOffset = (a: WaterfallSpan, b: WaterfallSpan): number =>
    a.offsetMs - b.offsetMs || a.sequence - b.sequence;
  for (const node of nodeById.values()) node.children.sort(byOffset);
  roots.sort(byOffset);

  return { traceStartMs, totalDurationMs, spans: roots, apps };
}

/** True when `outer` strictly encloses `inner` — contains the interval AND is
 *  genuinely larger on at least one side. Two spans with the SAME interval are
 *  siblings, not nested; a zero-width child inside a parent's bounds still nests. */
function contains(outer: Interval, inner: Interval): boolean {
  const encloses = outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
  const strictlyLarger = outer.startMs < inner.startMs || outer.endMs > inner.endMs;
  return encloses && strictlyLarger;
}
