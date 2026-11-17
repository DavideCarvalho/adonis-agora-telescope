import { randomUUID } from 'node:crypto';
import { runAsTelescopeWork } from '../../self_scope.js';
import { PollingConsumer } from './polling.js';
import {
  type ControlPlaneChannel,
  encodeEnvelope,
  errorMessage,
  type MessageHandler,
  type OutgoingBatch,
  type SendOutcome,
  type TelescopeTransport,
  type TenantChannel,
  type TransportContext,
} from './types.js';

/**
 * The Redis client the driver talks through: an `@adonisjs/redis` connection or an `ioredis`
 * client (both have `call()`).
 */
export interface RedisCallClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
}

/** Options of `transports.redis()`. */
export interface RedisTransportOptions {
  /** An `@adonisjs/redis` connection name (`config/redis.ts`). Default its default connection. */
  connection?: string;
  /** Key prefix: the stream is `<prefix>:ingest`, dead letters go to `<prefix>:ingest:dead`. Default `telescope`. */
  prefix?: string;
  /** Escape hatch: a client used instead of `@adonisjs/redis` (an `ioredis` instance). */
  client?: RedisCallClient;
  /** Stream length cap (approximate, `MAXLEN ~`): past it the oldest messages go. Default 100,000. */
  maxLength?: number;
  /** Control plane: consumer group name. Default `telescope`. */
  group?: string;
  /**
   * Control plane: how long one read waits on the server for a message (`XREADGROUP ... BLOCK`).
   * The read runs on a connection of its own, duplicated from the client. `0` turns the blocking
   * read off (the stream is polled every `pollIntervalMs`). Default 10,000 ms.
   */
  blockMs?: number;
  /**
   * Control plane: how often an empty stream is polled when the read cannot block (`blockMs: 0`,
   * or a `client` that cannot be duplicated); also the pause after a failed read. Default 500 ms.
   */
  pollIntervalMs?: number;
  /** Control plane: how often pending messages are looked at (`XPENDING`) for a take-over. Default 30,000 ms. */
  reclaimIntervalMs?: number;
  /**
   * Control plane: how often messages every consumer group acknowledged are trimmed from the
   * stream (`XTRIM MINID ~`), when there were any. Default 30,000 ms.
   */
  trimIntervalMs?: number;
  /** Control plane: messages read per poll. Default 50. */
  readCount?: number;
  /** Control plane: an unacknowledged message older than this is taken over (a dead consumer). Default 60,000 ms. */
  claimIdleMs?: number;
  /** Control plane: deliveries of one message before it is dead-lettered. Default 5. */
  maxAttempts?: number;
}

const FIELD = 'm';

/** The envelope without its bearer token: what a dead-letter copy keeps. */
export function withoutToken(raw: string): string {
  try {
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    if (envelope !== null && typeof envelope === 'object' && 'token' in envelope) {
      envelope.token = '[redacted]';
      return JSON.stringify(envelope);
    }
  } catch {
    // Not JSON: nothing to redact.
  }
  return raw;
}

async function resolveClient(
  options: RedisTransportOptions,
  ctx: TransportContext,
): Promise<RedisCallClient> {
  if (options.client) return options.client;
  const app = ctx.app;
  if (
    !app ||
    (typeof app.container.hasBinding === 'function' && !app.container.hasBinding('redis'))
  ) {
    throw new Error(
      '[@adonis-agora/telescope] transports.redis() needs @adonisjs/redis configured (node ace add @adonisjs/redis), or a `client`',
    );
  }
  const redis = (await app.container.make('redis')) as {
    connection(name?: string): RedisCallClient;
  };
  return redis.connection(options.connection);
}

function keys(options: RedisTransportOptions) {
  const prefix = options.prefix ?? 'telescope';
  return { stream: `${prefix}:ingest`, dead: `${prefix}:ingest:dead` };
}

/** `XADD`s each batch to the stream. */
export class RedisTenantChannel implements TenantChannel {
  constructor(
    private readonly client: RedisCallClient,
    private readonly stream: string,
    private readonly maxLength: number,
  ) {}

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    try {
      await this.client.call(
        'XADD',
        this.stream,
        'MAXLEN',
        '~',
        this.maxLength,
        '*',
        FIELD,
        encodeEnvelope(batch),
      );
      return { kind: 'ok' };
    } catch (error) {
      return { kind: 'failed', message: `redis refused the batch: ${errorMessage(error)}` };
    }
  }
}

type StreamMessages = Array<[string, string[] | null]>;

/**
 * The messages of an `XREADGROUP` reply, whichever shape the connection speaks: RESP2
 * (`[[stream, messages], ...]`) or RESP3, which a client may hand back as a flattened map
 * (`[stream, messages, ...]`).
 */
export function streamMessages(reply: unknown): StreamMessages {
  if (!Array.isArray(reply) || reply.length === 0) return [];
  const out: StreamMessages = [];
  if (typeof reply[0] === 'string' || Buffer.isBuffer(reply[0])) {
    for (let i = 1; i < reply.length; i += 2) out.push(...((reply[i] as StreamMessages) ?? []));
  } else {
    for (const pair of reply as Array<[unknown, StreamMessages]>) out.push(...(pair?.[1] ?? []));
  }
  return out;
}

/** A reply entry as an object: RESP2 gives `[key, value, ...]`, RESP3 a map (or an object). */
function record(entry: unknown): Record<string, unknown> {
  if (entry instanceof Map) return Object.fromEntries(entry);
  if (Array.isArray(entry)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < entry.length; i += 2) out[String(entry[i])] = entry[i + 1];
    return out;
  }
  return (entry ?? {}) as Record<string, unknown>;
}

/** Orders two stream ids (`<ms>-<seq>`). */
export function compareIds(a: string, b: string): number {
  const [am = 0n, as = 0n] = a.split('-').map((part) => BigInt(part || 0));
  const [bm = 0n, bs = 0n] = b.split('-').map((part) => BigInt(part || 0));
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

/** The id right after `id`: `MINID` keeps messages from it on. */
function nextId(id: string): string {
  const [ms = '0', seq = '0'] = id.split('-');
  return `${ms}-${BigInt(seq || 0) + 1n}`;
}

/** A client that can open its own connection: an `ioredis` client (or cluster). */
interface DuplicableClient {
  duplicate(): BlockingClient;
}

/** The dedicated connection the blocking read runs on. */
export interface BlockingClient extends RedisCallClient {
  disconnect(): void;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

function canDuplicate(value: unknown): value is DuplicableClient {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { duplicate?: unknown }).duplicate === 'function'
  );
}

/**
 * A dedicated connection for `XREADGROUP ... BLOCK`, which ties up the connection it runs on for
 * up to `blockMs`. An `ioredis` client is duplicated (same options, its own socket); an
 * `@adonisjs/redis` connection is duplicated through the `ioredis` client it wraps
 * (`ioConnection`). `null` when the client can do neither: the channel polls instead.
 */
export function dedicatedConnection(client: RedisCallClient): BlockingClient | null {
  if (canDuplicate(client)) return client.duplicate();
  const io = (client as { ioConnection?: unknown }).ioConnection;
  if (canDuplicate(io)) return io.duplicate();
  return null;
}

/** Options of {@link RedisControlPlaneChannel.once}. */
export interface RedisReadRound {
  /** Wait up to this long for a message (`XREADGROUP ... BLOCK`), on `connection`. */
  blockMs?: number;
  /** The connection the read runs on. Default the shared client. */
  connection?: RedisCallClient;
  /** Take over stale pending messages this round. Default: when `reclaimIntervalMs` has elapsed. */
  reclaim?: boolean;
}

/**
 * Reads the stream through a consumer group, acks what was stored, takes over messages a dead
 * consumer left pending, and moves a poison message (or one delivered `maxAttempts` times) to
 * `<prefix>:ingest:dead`.
 *
 * The read waits on the server (`XREADGROUP ... BLOCK blockMs`) on a connection of its own (see
 * {@link dedicatedConnection}), so an idle control plane sends one read per `blockMs` and a new
 * message is read as soon as it lands. A client that cannot open a connection (a custom `client`
 * with only `call()`), or `blockMs: 0`, polls every `pollIntervalMs` instead. Pending messages are
 * looked at (`XPENDING`) on start, after an error, and every `reclaimIntervalMs`.
 */
export class RedisControlPlaneChannel implements ControlPlaneChannel {
  private readonly consumer = `telescope-${randomUUID()}`;
  private readonly stream: string;
  private readonly dead: string;
  private readonly group: string;
  private poller: PollingConsumer | null = null;
  private blocking: BlockingClient | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private groupReady = false;
  /** 0: the first round looks at what a previous run left pending. */
  private lastReclaim = 0;
  private lastTrim = Date.now();
  /** Something was acked since the last trim. */
  private acked = false;

  constructor(
    private readonly client: RedisCallClient,
    private readonly options: RedisTransportOptions,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    ({ stream: this.stream, dead: this.dead } = keys(options));
    this.group = options.group ?? 'telescope';
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.running || this.poller) return;
    // The group is created on the first read, so a control plane boots while Redis is down.
    const blockMs = this.options.blockMs ?? 10_000;
    this.blocking = blockMs > 0 ? dedicatedConnection(this.client) : null;
    if (!this.blocking) {
      this.poller = new PollingConsumer(this.options.pollIntervalMs ?? 500, (error) => {
        this.lastReclaim = 0;
        this.onError(error);
      });
      this.poller.start(() => this.once(handler));
      return;
    }
    const connection = this.blocking;
    // Connection errors surface through the failed read; without a listener ioredis prints them.
    connection.on?.('error', () => {});
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          // Telescope's own traffic: the broker reads are not recorded as app work.
          await runAsTelescopeWork(() => this.once(handler, { blockMs, connection }));
        } catch (error) {
          if (!this.running) break;
          this.lastReclaim = 0;
          this.onError(error);
          await this.pause(this.options.pollIntervalMs ?? 500);
        }
      }
    })();
  }

  /** Wait `ms` before the next read, cut short by `close()`. */
  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.wake?.(), ms);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    try {
      await this.client.call('XGROUP', 'CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!/BUSYGROUP/.test(errorMessage(error))) throw error;
    }
    this.groupReady = true;
  }

  /**
   * One read, after a take-over of stale pending messages when one is due; `true` when it found
   * any.
   */
  async once(handler: MessageHandler, round: RedisReadRound = {}): Promise<boolean> {
    await this.ensureGroup();
    // First what a dead consumer (or a failed attempt) left pending, so a blocked read never
    // holds it back.
    let found = false;
    const due = Date.now() - this.lastReclaim >= (this.options.reclaimIntervalMs ?? 30_000);
    if (round.reclaim ?? due) {
      this.lastReclaim = Date.now();
      found = await this.reclaim(handler, this.options.claimIdleMs ?? 60_000);
    }
    const count = this.options.readCount ?? 50;
    const block = round.blockMs && round.blockMs > 0 ? ['BLOCK', round.blockMs] : [];
    let reply: unknown;
    try {
      reply = await (round.connection ?? this.client).call(
        'XREADGROUP',
        'GROUP',
        this.group,
        this.consumer,
        'COUNT',
        count,
        ...block,
        'STREAMS',
        this.stream,
        '>',
      );
    } catch (error) {
      // The stream (and its group) went away, say Redis was flushed: create it again next round.
      if (/NOGROUP/.test(errorMessage(error))) this.groupReady = false;
      throw error;
    }
    const done: string[] = [];
    for (const [id, fields] of streamMessages(reply)) {
      found = true;
      if (await this.handle(handler, String(id), fields, 1)) done.push(String(id));
    }
    await this.ack(done);
    if (this.acked && Date.now() - this.lastTrim >= (this.options.trimIntervalMs ?? 30_000)) {
      await this.trim();
    }
    return found;
  }
  /** Take over messages pending longer than `idleMs` (their consumer died) and handle them again. */
  private async reclaim(handler: MessageHandler, idleMs: number): Promise<boolean> {
    const pending = (await this.client.call(
      'XPENDING',
      this.stream,
      this.group,
      'IDLE',
      idleMs,
      '-',
      '+',
      this.options.readCount ?? 50,
    )) as Array<[string, string, number, number]> | null;
    if (!pending || pending.length === 0) return false;
    const deliveries = new Map(pending.map(([id, , , count]) => [String(id), Number(count)]));
    // One XCLAIM for all of them; a message deleted meanwhile comes back empty (or not at all).
    const claimed = (await this.client.call(
      'XCLAIM',
      this.stream,
      this.group,
      this.consumer,
      idleMs,
      ...deliveries.keys(),
    )) as Array<[string, string[]] | null> | null;
    let found = false;
    const done: string[] = [];
    for (const message of claimed ?? []) {
      if (!message) continue;
      found = true;
      const id = String(message[0]);
      if (await this.handle(handler, id, message[1], (deliveries.get(id) ?? 0) + 1)) {
        done.push(id);
      }
    }
    await this.ack(done);
    return found;
  }

  private async handle(
    handler: MessageHandler,
    id: string,
    fields: string[] | null,
    deliveries: number,
  ): Promise<boolean> {
    const values = (fields ?? []).map(String);
    const at = values.indexOf(FIELD);
    const raw = at >= 0 ? (values[at + 1] ?? '') : '';
    const outcome = await handler(raw).catch(
      (error: unknown) => ({ kind: 'retry', reason: errorMessage(error) }) as const,
    );
    if (outcome.kind === 'ok') return true;
    const maxAttempts = this.options.maxAttempts ?? 5;
    if (outcome.kind === 'dead' || deliveries >= maxAttempts) {
      const reason = outcome.kind === 'dead' ? outcome.reason : `gave up: ${outcome.reason}`;
      await this.client.call(
        'XADD',
        this.dead,
        'MAXLEN',
        '~',
        10_000,
        '*',
        FIELD,
        withoutToken(raw),
        'reason',
        reason,
        'id',
        id,
      );
      return true;
    }
    // `retry`: left pending; taken over again after `claimIdleMs`.
    return false;
  }

  /**
   * One `XACK` for every message of a read that was stored (or dead-lettered). Acked messages
   * are not deleted one by one: {@link trim} drops them in bulk.
   */
  private async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.call('XACK', this.stream, this.group, ...ids);
    this.acked = true;
  }

  /**
   * Drop what every consumer group is done with: `XTRIM MINID ~` below the oldest message still
   * pending in any group (or, with nothing pending, past the last one a group was handed). A message
   * pending (or not yet read) is never trimmed, so a take-over still finds it. Runs every
   * `trimIntervalMs`, and only after something was acked. A failed trim is reported and retried
   * at the next interval; the stream stays capped by `maxLength` meanwhile.
   */
  private async trim(): Promise<void> {
    this.lastTrim = Date.now();
    this.acked = false;
    try {
      let floor: string | null = null;
      const groups = (await this.client.call('XINFO', 'GROUPS', this.stream)) as unknown[];
      for (const group of groups ?? []) {
        const info = record(group);
        // Nothing pending: everything up to the last message handed out is done.
        let oldest = nextId(String(info['last-delivered-id'] ?? '0-0'));
        if (Number(info.pending ?? 0) > 0) {
          const summary = (await this.client.call(
            'XPENDING',
            this.stream,
            String(info.name),
          )) as unknown[];
          if (summary?.[1] != null) oldest = String(summary[1]);
        }
        if (floor === null || compareIds(oldest, floor) < 0) floor = oldest;
      }
      if (floor !== null && floor !== '0-1') {
        await this.client.call('XTRIM', this.stream, 'MINID', '~', floor);
      }
    } catch (error) {
      this.acked = true;
      this.onError(error);
    }
  }

  /** Stop reading: the blocked read is cut short (its connection is closed), the message in hand finishes. */
  async close(): Promise<void> {
    this.running = false;
    this.wake?.();
    this.blocking?.disconnect();
    this.blocking = null;
    await this.loop?.catch(() => {});
    this.loop = null;
    await this.poller?.stop();
    this.poller = null;
  }
}

/** The Redis stream driver (`@adonisjs/redis`). */
export function redisTransport(options: RedisTransportOptions = {}): TelescopeTransport {
  const { stream } = keys(options);
  return {
    driver: 'redis',
    // Each send is an XADD (and an XREADGROUP + XACK on the control plane): fewer, fuller batches.
    bufferDefaults: { flushIntervalMs: 5000 },
    describe: () =>
      `redis stream ${JSON.stringify(stream)}${options.connection ? ` on connection ${JSON.stringify(options.connection)}` : ''}`,
    tenant: async (ctx) =>
      new RedisTenantChannel(
        await resolveClient(options, ctx),
        stream,
        options.maxLength ?? 100_000,
      ),
    controlPlane: async (ctx) =>
      new RedisControlPlaneChannel(await resolveClient(options, ctx), options, (error) =>
        ctx.logger?.warn(`[@adonis-agora/telescope] redis: ${errorMessage(error)}`),
      ),
    ping: async (ctx) => {
      const client = await resolveClient(options, ctx);
      await client.call('PING');
      return `Redis answers (stream ${JSON.stringify(stream)}).`;
    },
  };
}
