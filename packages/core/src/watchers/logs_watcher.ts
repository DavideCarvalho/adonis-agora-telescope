import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { safeRecord } from './record.js';

/** The standard pino/AdonisJS log levels this watcher tees, lowest → highest. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A single pino-style log method: either `(message, ...values)` or
 *  `(mergingObject, message?, ...values)`. We read only the message string and a
 *  bounded slice of the merging object. */
type LogMethod = (...args: unknown[]) => void;

/**
 * The structural slice of the AdonisJS `Logger` (`@adonisjs/logger`) this watcher
 * taps — the level methods. Mirrored structurally (rather than importing the
 * class) so the watcher stays unit-testable with a plain double and has no
 * build-time coupling to a specific logger version.
 */
export type LoggerLike = {
  [Level in LogLevel]?: LogMethod;
};

/** The recorded body of a `log` entry. */
export interface LogEntryContent {
  /** The log level (`'info'`, `'error'`, …). */
  level: LogLevel;
  /** The log message string, or `null` when the call carried only an object. */
  message: string | null;
  /** A bounded copy of the merging object's fields, or `null`. Redacted centrally. */
  context: Record<string, unknown> | null;
  /** The active trace id at log time, or `null`. */
  traceId: string | null;
}

/** Options for {@link LogsWatcher}. */
export interface LogsWatcherOptions {
  /** Only record at/above this level. Default `'trace'` (record everything). */
  minLevel?: LogLevel;
  /** Extra tags appended to every recorded log entry. */
  tags?: readonly string[];
}

/** Marks a wrapped method so a logger instance is teed exactly once even if two
 *  watchers (or two package copies) wrap it. */
const TEED = Symbol.for('@agora/telescope:logMethodTeed');

interface TeedMethod extends LogMethod {
  [TEED]?: boolean;
  __telescopeOriginal__?: LogMethod;
}

/**
 * Reentrancy guard: while recording a log we may ourselves log on failure, which
 * would re-enter the tee. The flag makes a nested log call through to the
 * original WITHOUT recording, breaking the record→log→record loop.
 */
let recording = false;

/**
 * Records AdonisJS `Logger` output as `EntryType.Log` entries, correlated to the
 * active request via the trace id.
 *
 * ## How it taps the logger (non-invasive, reversible)
 * Rather than monkey-patching a global or a prototype, `start(logger)` tees the
 * level methods on the ONE logger instance resolved from the container. Each teed
 * method calls the original first (host output is untouched) and then records.
 * `stop()` restores the originals, so the tap fully unwinds on shutdown.
 *
 * Pino has no supported post-construction transport/hook for a live instance, so
 * instance-scoped method-teeing is the least-invasive option that captures logs
 * written through the app logger without owning its construction. The tee is
 * idempotent per instance (a `Symbol.for` marker) and a reentrancy guard prevents
 * an infinite record→log loop.
 *
 * Recording is fire-and-forget and fully guarded — a telescope failure can never
 * break the host's logging.
 */
export class LogsWatcher {
  readonly type = EntryType.Log;
  private readonly minLevelIndex: number;
  private readonly extraTags: readonly string[];
  private logger: LoggerLike | null = null;

  constructor(options: LogsWatcherOptions = {}) {
    this.minLevelIndex = LOG_LEVELS.indexOf(options.minLevel ?? 'trace');
    this.extraTags = options.tags ?? [];
  }

  /** Tee the level methods on `logger`. Idempotent per instance. */
  start(logger: LoggerLike): void {
    if (this.logger) return;
    this.logger = logger;
    const watcher = this;

    for (let index = 0; index < LOG_LEVELS.length; index++) {
      const level: LogLevel = LOG_LEVELS[index] as LogLevel;
      const original = logger[level] as TeedMethod | undefined;
      if (typeof original !== 'function' || original[TEED]) continue;

      const teed = function teedLevel(this: unknown, ...args: unknown[]): void {
        // Nested log (e.g. our own failure logging) — call the original but
        // don't record, breaking the record→log→record loop.
        if (recording) {
          original.apply(this, args);
          return;
        }
        original.apply(this, args);
        if (index < watcher.minLevelIndex) return;
        recording = true;
        try {
          watcher.record(level, args);
        } finally {
          recording = false;
        }
      } as TeedMethod;
      teed[TEED] = true;
      teed.__telescopeOriginal__ = original;
      logger[level] = teed;
    }
  }

  /** Restore the original level methods on the tapped instance. */
  stop(): void {
    const logger = this.logger;
    if (!logger) return;
    this.logger = null;
    for (const level of LOG_LEVELS) {
      const current = logger[level] as TeedMethod | undefined;
      if (current?.[TEED] && current.__telescopeOriginal__) {
        logger[level] = current.__telescopeOriginal__;
      }
    }
  }

  /** Build + record a log entry from the level method's arguments. */
  private record(level: LogLevel, args: unknown[]): void {
    safeRecord(buildLogEntry(level, args, this.extraTags), 'LogsWatcher');
  }
}

/** A plain object literal (`{}` / `Object.create(null)`) — the only `mergingObject`
 *  shape we copy as structured context. Class instances, arrays, etc. are skipped. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse a pino-style level call into `{ message, context }`, mirroring pino's own
 * argument convention: either `(message, ...)` or `(mergingObject, message?, ...)`.
 * The context object is shallow-copied and bounded to a handful of keys here; the
 * central redaction layer scrubs any sensitive values before storage.
 */
export function extractLog(args: unknown[]): {
  message: string | null;
  context: Record<string, unknown> | null;
} {
  const [first, second] = args;
  if (isPlainObject(first)) {
    const context = boundContext(first);
    const message = typeof second === 'string' ? second : null;
    return { message, context };
  }
  return { message: typeof first === 'string' ? first : null, context: null };
}

/** Shallow-copy at most the first 50 own keys of a merging object — a bound so a
 *  single log entry can't retain an unbounded structured payload. */
function boundContext(object: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(object)) {
    if (count >= 50) break;
    out[key] = object[key];
    count++;
  }
  return out;
}

/** Map a level + raw method args to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without teeing a logger. */
export function buildLogEntry(
  level: LogLevel,
  args: unknown[],
  extraTags: readonly string[] = [],
): RecordInput<LogEntryContent> {
  const { message, context } = extractLog(args);
  const traceId = currentTraceId();
  const content: LogEntryContent = { level, message, context, traceId };
  return {
    type: EntryType.Log,
    familyHash: `log:${level}`,
    content,
    traceId,
    tags: ['log', `log:${level}`, ...extraTags],
  };
}
