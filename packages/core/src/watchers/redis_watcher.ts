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

  /** Construct with the resolved `@adonisjs/redis` manager (or `null` when the
   *  optional peer is absent — the watcher then no-ops). */
  constructor(manager: unknown) {
    this.manager = isManager(manager) ? manager : null;
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
    safeRecord(buildRedisEntry(command, connection, durationMs), 'RedisWatcher');
  }
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
