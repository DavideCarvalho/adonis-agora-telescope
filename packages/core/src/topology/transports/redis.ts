import { randomUUID } from 'node:crypto';
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
  /** Control plane: how often an empty stream is polled. Default 500 ms. */
  pollIntervalMs?: number;
  /** Control plane: messages read per poll. Default 50. */
  readCount?: number;
  /** Control plane: an unacknowledged message older than this is taken over (a dead consumer). Default 60,000 ms. */
  claimIdleMs?: number;
  /** Control plane: deliveries of one message before it is dead-lettered. Default 5. */
  maxAttempts?: number;
}

const FIELD = 'm';

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

/**
 * Reads the stream through a consumer group (`XREADGROUP`, never blocking the connection), acks
 * what was stored, takes over messages a dead consumer left pending, and moves a poison message
 * (or one delivered `maxAttempts` times) to `<prefix>:ingest:dead`.
 */
export class RedisControlPlaneChannel implements ControlPlaneChannel {
  private readonly poller: PollingConsumer;
  private readonly consumer = `telescope-${randomUUID()}`;
  private readonly stream: string;
  private readonly dead: string;
  private readonly group: string;

  constructor(
    private readonly client: RedisCallClient,
    private readonly options: RedisTransportOptions,
    onError: (error: unknown) => void = () => {},
  ) {
    ({ stream: this.stream, dead: this.dead } = keys(options));
    this.group = options.group ?? 'telescope';
    this.poller = new PollingConsumer(options.pollIntervalMs ?? 500, onError);
  }

  async start(handler: MessageHandler): Promise<void> {
    // The group is created on the first read, so a control plane boots while Redis is down.
    this.poller.start(() => this.once(handler));
  }

  private groupReady = false;

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    try {
      await this.client.call('XGROUP', 'CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!/BUSYGROUP/.test(errorMessage(error))) throw error;
    }
    this.groupReady = true;
  }

  /** One read (and, now and then, one take-over of stale pending messages); `true` when it found any. */
  async once(handler: MessageHandler): Promise<boolean> {
    await this.ensureGroup();
    const reply = await this.client.call(
      'XREADGROUP',
      'GROUP',
      this.group,
      this.consumer,
      'COUNT',
      this.options.readCount ?? 50,
      'STREAMS',
      this.stream,
      '>',
    );
    let found = false;
    for (const [id, fields] of streamMessages(reply)) {
      found = true;
      await this.handle(handler, String(id), fields, 1);
    }
    // Nothing new: take over what a dead consumer (or a failed attempt) left pending.
    if (!found) found = await this.reclaim(handler, this.options.claimIdleMs ?? 60_000);
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
    let found = false;
    for (const [id, , , deliveries] of pending ?? []) {
      const claimed = (await this.client.call(
        'XCLAIM',
        this.stream,
        this.group,
        this.consumer,
        idleMs,
        id,
      )) as Array<[string, string[]] | null> | null;
      const message = claimed?.[0];
      if (!message) continue;
      found = true;
      await this.handle(handler, message[0], message[1], Number(deliveries) + 1);
    }
    return found;
  }

  private async handle(
    handler: MessageHandler,
    id: string,
    fields: string[] | null,
    deliveries: number,
  ): Promise<void> {
    const values = (fields ?? []).map(String);
    const at = values.indexOf(FIELD);
    const raw = at >= 0 ? (values[at + 1] ?? '') : '';
    const outcome = await handler(raw).catch(
      (error: unknown) => ({ kind: 'retry', reason: errorMessage(error) }) as const,
    );
    if (outcome.kind === 'ok') {
      await this.ack(id);
      return;
    }
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
        raw,
        'reason',
        reason,
        'id',
        id,
      );
      await this.ack(id);
    }
    // `retry`: left pending; taken over again after `claimIdleMs`.
  }

  private async ack(id: string): Promise<void> {
    await this.client.call('XACK', this.stream, this.group, id);
    await this.client.call('XDEL', this.stream, id);
  }

  async close(): Promise<void> {
    await this.poller.stop();
  }
}

/** The Redis stream driver (`@adonisjs/redis`). */
export function redisTransport(options: RedisTransportOptions = {}): TelescopeTransport {
  const { stream } = keys(options);
  return {
    driver: 'redis',
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
