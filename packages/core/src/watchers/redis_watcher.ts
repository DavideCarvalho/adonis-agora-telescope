import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { safeRecord } from './record.js';

/**
 * A single ioredis command, structurally. `name` is the command (e.g. `get`),
 * `args` are its arguments. This is the shape of the ioredis `Command` object the
 * client funnels every command through (`Command.name` / `Command.args`).
 */
export interface RedisCommandLike {
  name?: string;
  args?: unknown[];
}

/**
 * The structural ioredis client surface this watcher wraps. `@adonisjs/redis`
 * exposes the raw ioredis client on `connection().ioConnection`; ioredis funnels
 * EVERY command through `sendCommand(command)`, so wrapping that single method
 * captures everything (including pipelined / multi commands). `Command.promise`
 * resolves with the reply, letting us time the round-trip.
 */
export interface RedisClientLike {
  sendCommand(command: RedisCommandLike, ...rest: unknown[]): unknown;
}

/**
 * The structural slice of a `@adonisjs/redis` connection: the raw ioredis client
 * under `ioConnection`, and (when subscribing has occurred) the separate
 * subscriber client. A connection name is read for tagging when present.
 */
export interface RedisConnectionLike {
  connectionName?: string;
  ioConnection?: unknown;
  ioSubscriberConnection?: unknown;
}

/**
 * The structural slice of the `@adonisjs/redis` manager: it exposes the active
 * connections and emits a `'connection'` event (via `emittery`, returning an
 * unsubscribe function) as each new connection is created. The watcher uses both
 * to instrument current AND future connections.
 */
export interface RedisManagerLike {
  activeConnections?: Record<string, RedisConnectionLike> | undefined;
  on?(event: 'connection', listener: (connection: RedisConnectionLike) => void): () => void;
}

/** The recorded body of a `redis` entry. */
export interface RedisEntryContent {
  /** The command name, upper-cased (e.g. `'GET'`). */
  command: string;
  /** The command arguments, in order (redaction applies downstream). */
  args: unknown[];
  /** The connection name (e.g. `'main'`), or `null`. */
  connection: string | null;
  /** Round-trip duration in ms, or `null` when not awaitable. */
  durationMs: number | null;
  /** The active trace id at command time, or `null`. */
  traceId: string | null;
}

/** Marks a client whose `sendCommand` we've already wrapped, so the same instance
 *  (or two watchers / package copies sharing it) is never double-wrapped. A
 *  `Symbol.for` so both copies resolve the same brand. */
const PATCHED = Symbol.for('@agora/telescope:redisPatched');

/** A wrappable client carrying our idempotency brand + the original it replaced. */
interface BrandedRedisClient extends RedisClientLike {
  [PATCHED]?: boolean;
  __telescopeOriginalSendCommand__?: RedisClientLike['sendCommand'] | undefined;
}

/** Narrow an arbitrary value to one with a usable `sendCommand`. */
function hasSendCommand(value: unknown): value is BrandedRedisClient {
  if (typeof value !== 'object' || value === null || !('sendCommand' in value)) return false;
  return typeof (value as { sendCommand: unknown }).sendCommand === 'function';
}

/** Best-effort high-resolution clock; falls back to `Date.now()`. */
function now(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** True when a value looks like a thenable (so the round-trip can be timed). */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

/**
 * Tuning for the redis watcher.
 *
 * Redis is the highest-frequency thing most apps touch, and a watcher that records
 * EVERY command turns telescope's own table into the busiest table in the database.
 * The observed case that motivated these options: `@adonisjs/limiter` issues
 * ~5 commands (`MULTI`/`GET`/`PTTL`/`EVALSHA`/`EXEC`) per rate-limited request, and
 * recording them produced 211 entries/minute — 93% of a 532k-row table, none of it
 * about the application.
 *
 * Nothing is filtered by DEFAULT: what counts as noise is the app's call, and a lib
 * that silently drops a command someone is debugging is worse than a loud table. The
 * default is instead {@link floodWarnPerMinute}, which makes the cost announce itself.
 */
export interface RedisWatcherOptions {
  /**
   * Command names (case-insensitive) that are never recorded — e.g.
   * `['MULTI', 'EXEC', 'PTTL']` to drop transaction bookkeeping while keeping the
   * reads and writes it wraps.
   */
  ignoreCommands?: string[];
  /**
   * Key patterns whose commands are never recorded. A string matches as a PREFIX
   * (`'myapp:rlflx:'` drops every rate-limiter key); a RegExp is tested as-is. Only
   * the first argument is examined, which is the key for every keyed redis command.
   */
  ignoreKeys?: Array<string | RegExp>;
  /** Connection names (exact, case-insensitive) whose commands are NOT recorded —
   *  e.g. drop the connection telescope's own redis store uses. */
  ignoreConnections?: string[];
  /**
   * Record only this fraction of commands, 0..1. Default `1` (record all).
   *
   * Sampling is per-COMMAND, so a sampled trace shows some of its redis calls and
   * not others — good for volume, bad for reading one request end-to-end. Prefer
   * {@link ignoreKeys} when you know what the noise is; reach for sampling when you
   * do not.
   */
  sampleRate?: number;
  /**
   * Warn (once) on stderr when recording exceeds this many entries per minute,
   * naming the loudest command and key prefix so the fix is a paste. Default 600.
   * Set `0` to disable.
   */
  floodWarnPerMinute?: number;
}

/** Default flood threshold (entries/minute) — see {@link RedisWatcherOptions.floodWarnPerMinute}. */
const DEFAULT_FLOOD_WARN_PER_MINUTE = 600;

/** The first argument of a redis command, as a string, or `null` when unkeyed. */
function firstKey(command: RedisCommandLike): string | null {
  const args = command.args;
  if (!Array.isArray(args) || args.length === 0) return null;
  const key = args[0];
  if (typeof key === 'string') return key;
  // ioredis passes Buffers for binary-safe keys; only decode when it is cheap.
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(key) ? key.toString('utf8') : null;
}

/**
 * Records every Redis command issued through `@adonisjs/redis` as a `redis`
 * telescope entry — the command name, args, connection and round-trip duration,
 * correlated to the active trace.
 *
 * ## How it works
 * `@adonisjs/redis` is an OPTIONAL peer (not installed in this repo, so its surface
 * is sourced from its types, not verified here). Its connection wrapper exposes the
 * raw ioredis client on `connection().ioConnection`, and ioredis funnels every
 * command through `sendCommand(command)`. The watcher monkey-patches that single
 * method on each connection's ioredis client: it captures `{ name, args }`, times
 * the round-trip via the command's returned promise, and records the entry. The
 * original is always called and its result returned/thrown unchanged — recording
 * failures are swallowed so a telescope error can never alter a command's outcome.
 *
 * The watcher is constructed with the `@adonisjs/redis` manager: at {@link start}
 * it instruments every already-active connection and arms the manager's
 * `'connection'` event so connections created later are instrumented too. Patching
 * is per-client and idempotent; {@link stop} restores every original `sendCommand`.
 *
 * ## Caveat
 * It records exactly what each wrapped client does. If telescope's own redis
 * storage shares a connection, those commands would be captured too — use a
 * dedicated connection for telescope storage to avoid that noise.
 */
export class RedisWatcher {
  readonly type = EntryType.Redis;
  private readonly manager: RedisManagerLike | null;
  /** Clients we patched, with their connection name, for clean restore on stop. */
  private readonly wrapped: Array<{ client: BrandedRedisClient; connection: string | null }> = [];
  private unsubscribeManager: (() => void) | null = null;

  private readonly ignoreCommands: Set<string>;
  private readonly ignoreKeys: Array<string | RegExp>;
  private readonly ignoreConnections: Set<string>;
  private readonly sampleRate: number;
  private readonly floodWarnPerMinute: number;

  /** Flood accounting: entries recorded in the current minute, plus the loudest
   *  command/key seen, so the warning can name the actual culprit. */
  private windowStartedAt = now();
  private windowCount = 0;
  private readonly windowCommands = new Map<string, number>();
  private readonly windowKeyPrefixes = new Map<string, number>();
  private floodWarned = false;

  /** Construct with the resolved `@adonisjs/redis` manager (or `null` when the
   *  optional peer is absent — the watcher then no-ops). */
  constructor(manager: unknown, options: RedisWatcherOptions = {}) {
    this.manager = isManager(manager) ? manager : null;
    this.ignoreCommands = new Set((options.ignoreCommands ?? []).map((c) => c.toUpperCase()));
    this.ignoreKeys = options.ignoreKeys ?? [];
    this.ignoreConnections = new Set(
      (options.ignoreConnections ?? []).map((c) => c.toLowerCase()),
    );
    // Clamp rather than throw: a bad sampleRate should not take the app down at boot.
    this.sampleRate = Math.min(1, Math.max(0, options.sampleRate ?? 1));
    this.floodWarnPerMinute = Math.max(0, options.floodWarnPerMinute ?? DEFAULT_FLOOD_WARN_PER_MINUTE);
  }

  /**
   * Whether this command is recorded. Ordered cheapest-first: the connection and
   * command checks are set lookups, the key check walks the (usually empty) pattern
   * list, and sampling comes last so a filtered-out command never burns entropy.
   */
  shouldRecord(command: RedisCommandLike, connection: string | null): boolean {
    if (connection !== null && this.ignoreConnections.has(connection.toLowerCase())) return false;

    const name = typeof command.name === 'string' ? command.name.toUpperCase() : '';
    if (this.ignoreCommands.has(name)) return false;

    if (this.ignoreKeys.length > 0) {
      const key = firstKey(command);
      if (key !== null) {
        for (const pattern of this.ignoreKeys) {
          const hit =
            typeof pattern === 'string' ? key.startsWith(pattern) : pattern.test(key);
          if (hit) return false;
        }
      }
    }

    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) return false;
    return true;
  }

  /** Instrument current + future connections. Idempotent. A no-op when the peer
   *  is absent. */
  start(): void {
    if (!this.manager) return;
    if (this.unsubscribeManager) return;

    const active = this.manager.activeConnections;
    if (active && typeof active === 'object') {
      for (const connection of Object.values(active)) this.instrument(connection);
    }

    if (typeof this.manager.on === 'function') {
      this.unsubscribeManager = this.manager.on('connection', (connection) =>
        this.instrument(connection),
      );
    }
  }

  /** Restore every wrapped `sendCommand` and stop watching for new connections. */
  stop(): void {
    this.unsubscribeManager?.();
    this.unsubscribeManager = null;
    for (const { client } of this.wrapped) {
      const original = client.__telescopeOriginalSendCommand__;
      if (original) {
        client.sendCommand = original;
        client[PATCHED] = false;
        client.__telescopeOriginalSendCommand__ = undefined;
      }
    }
    this.wrapped.length = 0;
  }

  /** Wrap the ioredis client(s) backing a connection. */
  private instrument(connection: RedisConnectionLike): void {
    if (!connection || typeof connection !== 'object') return;
    const name = typeof connection.connectionName === 'string' ? connection.connectionName : null;
    this.wrap(connection.ioConnection, name);
    this.wrap(connection.ioSubscriberConnection, name);
  }

  /** Monkey-patch one ioredis client's `sendCommand`. No-op when it lacks the
   *  method or is already wrapped. */
  private wrap(candidate: unknown, connection: string | null): void {
    if (!hasSendCommand(candidate)) return;
    const client = candidate;
    if (client[PATCHED]) return;
    client[PATCHED] = true;

    const watcher = this;
    // Keep the EXACT original reference for a clean restore on stop(); call it
    // with the client as `this` so binding is not baked into what we restore.
    const original = client.sendCommand;
    client.__telescopeOriginalSendCommand__ = original;
    this.wrapped.push({ client, connection });

    client.sendCommand = function patchedSendCommand(
      this: unknown,
      command: RedisCommandLike,
      ...rest: unknown[]
    ): unknown {
      // Decided BEFORE the call so a filtered command costs one set lookup and
      // never allocates a finalize closure or attaches to the command's promise.
      if (!watcher.shouldRecord(command, connection)) {
        return original.call(client, command, ...rest);
      }
      const startedAt = now();
      const result = original.call(client, command, ...rest);
      if (isThenable(result)) {
        const finalize = (): void => {
          watcher.record(command, connection, now() - startedAt);
        };
        result.then(finalize, finalize);
      } else {
        watcher.record(command, connection, null);
      }
      return result;
    };
  }

  private record(
    command: RedisCommandLike,
    connection: string | null,
    durationMs: number | null,
  ): void {
    this.accountForFlood(command);
    safeRecord(buildRedisEntry(command, connection, durationMs), 'RedisWatcher');
  }

  /**
   * Count what we record in a rolling one-minute window and, the first time it
   * crosses the threshold, warn ONCE naming the loudest command and key prefix.
   *
   * This exists because the failure mode is silent: nothing breaks, the app is fine,
   * and you only discover the watcher is writing 300k rows/day when a console screen
   * gets slow enough to complain about. Naming the culprit turns the fix into a paste
   * instead of an investigation.
   */
  private accountForFlood(command: RedisCommandLike): void {
    if (this.floodWarnPerMinute === 0 || this.floodWarned) return;

    const elapsed = now() - this.windowStartedAt;
    if (elapsed >= 60_000) {
      this.windowStartedAt = now();
      this.windowCount = 0;
      this.windowCommands.clear();
      this.windowKeyPrefixes.clear();
    }

    this.windowCount++;
    const name = typeof command.name === 'string' ? command.name.toUpperCase() : '(unknown)';
    this.windowCommands.set(name, (this.windowCommands.get(name) ?? 0) + 1);
    const key = firstKey(command);
    if (key !== null) {
      // Group by the first two colon-segments — `app:rlflx:foo` → `app:rlflx`, which
      // is the granularity someone would actually paste into `ignoreKeys`.
      const prefix = key.split(':').slice(0, 2).join(':');
      this.windowKeyPrefixes.set(prefix, (this.windowKeyPrefixes.get(prefix) ?? 0) + 1);
    }

    if (this.windowCount < this.floodWarnPerMinute) return;
    this.floodWarned = true;
    console.warn(formatFloodWarning(this.windowCount, this.windowCommands, this.windowKeyPrefixes));
  }
}

/** Largest-count entry of a tally, or `null` when empty. */
function topOf(tally: Map<string, number>): { name: string; count: number } | null {
  let top: { name: string; count: number } | null = null;
  for (const [name, count] of tally) {
    if (top === null || count > top.count) top = { name, count };
  }
  return top;
}

/** The flood warning text. Exported for tests — the VALUE here is that the message
 *  names the culprit and the exact option, so it is worth pinning. */
export function formatFloodWarning(
  count: number,
  commands: Map<string, number>,
  keyPrefixes: Map<string, number>,
): string {
  const command = topOf(commands);
  const prefix = topOf(keyPrefixes);
  const lines = [
    `Telescope: the redis watcher recorded ${count} entries in the last minute. ` +
      'At that rate it will dominate your telescope table and slow the console down.',
  ];
  if (command) lines.push(`  loudest command: ${command.name} (${command.count})`);
  if (prefix) {
    lines.push(`  loudest key prefix: ${prefix.name} (${prefix.count})`);
    lines.push(
      `  to drop it: redis: { ignoreKeys: ['${prefix.name}:'] } in config/telescope_watchers.ts`,
    );
  }
  lines.push('  (or set redis.floodWarnPerMinute: 0 to silence this warning)');
  return lines.join('\n');
}

/** Narrow an arbitrary value to a {@link RedisManagerLike}. */
function isManager(value: unknown): value is RedisManagerLike {
  return typeof value === 'object' && value !== null;
}

/** Map a captured Redis command to a telescope {@link RecordInput}. Exported so
 *  the entry shape can be unit-tested without a real ioredis client. */
export function buildRedisEntry(
  command: RedisCommandLike,
  connection: string | null,
  durationMs: number | null,
): RecordInput<RedisEntryContent> {
  const name =
    typeof command.name === 'string' ? command.name.toUpperCase() : String(command.name ?? '');
  const args = Array.isArray(command.args) ? command.args : [];
  const traceId = currentTraceId();
  const content: RedisEntryContent = {
    command: name,
    args,
    connection,
    durationMs: durationMs === null ? null : Math.max(0, durationMs),
    traceId,
  };
  return {
    type: EntryType.Redis,
    familyHash: `redis:${name}`,
    content,
    durationMs: content.durationMs,
    traceId,
    tags: ['redis', `redis:${name}`, ...(connection ? [`connection:${connection}`] : [])],
  };
}
