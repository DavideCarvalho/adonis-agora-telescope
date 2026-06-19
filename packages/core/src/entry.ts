/**
 * The built-in Telescope entry types shipped by `@agora/telescope`. Adapted from
 * the NestJS `nestjs-telescope` core, trimmed to the headless slice this package
 * actually records (request + diagnostic). The remaining values are reserved so a
 * future watcher (a Lucid query watcher, a mailer watcher, …) can record under a
 * stable, already-documented type without a breaking change.
 */
export const EntryType = {
  /** An inbound HTTP request, recorded by {@link TelescopeMiddleware}. */
  Request: 'request',
  /** A single `agora:<lib>:<event>` diagnostics publish. */
  Diagnostic: 'diagnostic',
  // — reserved for deferred per-tech watchers (see DESIGN.md) —
  Query: 'query',
  Job: 'job',
  Exception: 'exception',
  Mail: 'mail',
  Cache: 'cache',
  Redis: 'redis',
  Event: 'event',
  Log: 'log',
} as const;

export type BuiltinEntryType = (typeof EntryType)[keyof typeof EntryType];

/**
 * Where a batch of entries originated. An entry recorded inside an HTTP request
 * is `http`; one recorded by a queue worker is `queue`; a diagnostic recorded
 * with no active request defaults to `manual`.
 */
const BATCH_ORIGINS = ['http', 'queue', 'schedule', 'cli', 'manual'] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export function isBatchOrigin(value: unknown): value is BatchOrigin {
  return typeof value === 'string' && (BATCH_ORIGINS as readonly string[]).includes(value);
}

/**
 * A captured, persisted observability record. `content` is type-specific (e.g.
 * {@link RequestEntryContent} for a `request`, {@link DiagnosticEntryContent} for
 * a `diagnostic`).
 */
export interface Entry<TContent = unknown> {
  /** Unique id of this entry. */
  id: string;
  /** The entry type, one of {@link EntryType} (or a custom string). */
  type: string;
  /**
   * Stable grouping key — entries that share a `familyHash` are "the same kind of
   * thing" (e.g. all `billing:invoice-paid` diagnostics). `null` when the entry
   * is not groupable.
   */
  familyHash: string | null;
  /** The type-specific payload. */
  content: TContent;
  /** Searchable labels, e.g. `lib:billing`, `event:invoice-paid`, `status:500`. */
  tags: string[];
  /** Monotonic record order within this process. */
  sequence: number;
  /** Wall-clock duration of the recorded operation, when known. */
  durationMs: number | null;
  /** Where the recording happened. */
  origin: BatchOrigin;
  /** The active trace id at record time, or `null` when no context. */
  traceId: string | null;
  /** When the entry was recorded. */
  createdAt: Date;
}

/**
 * What a watcher hands to {@link TelescopeStore.record}. The store fills in `id`,
 * `sequence`, `createdAt`, and resolves `traceId`/`origin` from the ambient
 * context when the caller omits them.
 */
export interface RecordInput<TContent = unknown> {
  type: string;
  content: TContent;
  familyHash?: string | null;
  tags?: string[];
  durationMs?: number | null;
  /** Override the resolved trace id; defaults to the ambient `@agora/context`. */
  traceId?: string | null;
  /** Override the batch origin; defaults to `http` when a request is active. */
  origin?: BatchOrigin;
}
