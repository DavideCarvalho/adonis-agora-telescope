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

/** The slice of an `@adonisjs/queue` (`@boringnode/queue`) adapter the queue driver uses. */
export interface QueueAdapterLike {
  setWorkerId(id: string): void;
  pushOn(queue: string, job: QueueJobData): Promise<unknown>;
  popFrom(queue: string): Promise<(QueueJobData & { acquiredAt?: number }) | null>;
  completeJob(id: string, queue: string): Promise<void>;
  failJob(id: string, queue: string, error?: Error): Promise<void>;
  retryJob(id: string, queue: string, retryAt?: Date): Promise<void>;
  destroy?(): Promise<void>;
}

export interface QueueJobData {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  createdAt?: number;
}

/** A `config/queue.ts` `adapters` entry: an adapter factory, or a config provider of one. */
type AdapterEntry =
  | (() => QueueAdapterLike)
  | { resolver: (app: unknown) => (() => QueueAdapterLike) | Promise<() => QueueAdapterLike> };

/** Options of `transports.queue()`. */
export interface QueueTransportOptions {
  /** A key of `adapters` in `config/queue.ts`. Default that file's `default`. */
  connection?: string;
  /** The queue batches are pushed on. Default `telescope-ingest`. */
  queue?: string;
  /** Escape hatch: an adapter factory used instead of `config/queue.ts`. */
  adapter?: () => QueueAdapterLike;
  /** Control plane: how often an empty queue is polled. Default 500 ms. */
  pollIntervalMs?: number;
  /** Control plane: deliveries of one message before it is dead-lettered (failed). Default 5. */
  maxAttempts?: number;
}

const DEFAULT_QUEUE = 'telescope-ingest';
const JOB_NAME = 'telescope.ingest';

async function resolveAdapter(
  options: QueueTransportOptions,
  ctx: TransportContext,
): Promise<QueueAdapterLike> {
  if (options.adapter) return options.adapter();
  const app = ctx.app;
  if (!app) {
    throw new Error(
      '[@adonis-agora/telescope] transports.queue() needs the app (config/queue.ts) or an `adapter`',
    );
  }
  const config = app.config.get<{ default?: string; adapters?: Record<string, AdapterEntry> }>(
    'queue',
    {},
  );
  const name = options.connection ?? config?.default;
  if (!name || !config?.adapters) {
    throw new Error(
      '[@adonis-agora/telescope] transports.queue() needs @adonisjs/queue configured (node ace add @adonisjs/queue), or a `connection`',
    );
  }
  const entry = config.adapters[name];
  if (!entry) {
    throw new Error(
      `[@adonis-agora/telescope] transports.queue(): no connection "${name}" in config/queue.ts`,
    );
  }
  const factory = typeof entry === 'function' ? entry : await entry.resolver(app);
  return factory();
}

/** Pushes each batch as one job. */
export class QueueTenantChannel implements TenantChannel {
  constructor(
    private readonly adapter: QueueAdapterLike,
    private readonly queue: string,
  ) {}

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    try {
      await this.adapter.pushOn(this.queue, {
        id: batch.id,
        name: JOB_NAME,
        payload: encodeEnvelope(batch),
        attempts: 0,
        createdAt: Date.now(),
      });
      return { kind: 'ok' };
    } catch (error) {
      return { kind: 'failed', message: `the queue refused the batch: ${errorMessage(error)}` };
    }
  }

  async close(): Promise<void> {
    await this.adapter.destroy?.();
  }
}

/** Pops jobs and hands each to the ingest handler. A dead message is failed (the queue's DLQ). */
export class QueueControlPlaneChannel implements ControlPlaneChannel {
  private readonly poller: PollingConsumer;

  constructor(
    private readonly adapter: QueueAdapterLike,
    private readonly queue: string,
    private readonly options: { pollIntervalMs: number; maxAttempts: number },
    onError: (error: unknown) => void = () => {},
  ) {
    this.adapter.setWorkerId(`telescope-${randomUUID()}`);
    this.poller = new PollingConsumer(options.pollIntervalMs, onError);
  }

  async start(handler: MessageHandler): Promise<void> {
    this.poller.start(() => this.once(handler));
  }

  /** Take one job; `true` when there was one. */
  async once(handler: MessageHandler): Promise<boolean> {
    const job = await this.adapter.popFrom(this.queue);
    if (job === null) return false;
    const raw = typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload);
    const outcome = await handler(raw ?? '').catch(
      (error: unknown) => ({ kind: 'retry', reason: errorMessage(error) }) as const,
    );
    if (outcome.kind === 'ok') {
      await this.adapter.completeJob(job.id, this.queue);
    } else if (outcome.kind === 'dead' || job.attempts + 1 >= this.options.maxAttempts) {
      const reason = outcome.kind === 'dead' ? outcome.reason : `gave up: ${outcome.reason}`;
      await this.adapter.failJob(job.id, this.queue, new Error(reason));
    } else {
      const delay = Math.min(60_000, 1000 * 2 ** job.attempts);
      await this.adapter.retryJob(job.id, this.queue, new Date(Date.now() + delay));
    }
    return true;
  }

  async close(): Promise<void> {
    await this.poller.stop();
    await this.adapter.destroy?.();
  }
}

/** The `@adonisjs/queue` driver. */
export function queueTransport(options: QueueTransportOptions = {}): TelescopeTransport {
  const queue = options.queue ?? DEFAULT_QUEUE;
  return {
    driver: 'queue',
    describe: () =>
      `queue ${JSON.stringify(queue)}${options.connection ? ` on connection ${JSON.stringify(options.connection)}` : ''}`,
    tenant: async (ctx) => new QueueTenantChannel(await resolveAdapter(options, ctx), queue),
    controlPlane: async (ctx) =>
      new QueueControlPlaneChannel(
        await resolveAdapter(options, ctx),
        queue,
        {
          pollIntervalMs: options.pollIntervalMs ?? 500,
          maxAttempts: options.maxAttempts ?? 5,
        },
        (error) => ctx.logger?.warn(`[@adonis-agora/telescope] queue: ${errorMessage(error)}`),
      ),
    ping: async (ctx) => {
      const adapter = await resolveAdapter(options, ctx);
      try {
        // A read of a job that does not exist: answers when the backend is reachable.
        const probe = adapter as QueueAdapterLike & {
          getJob?(id: string, q: string): Promise<unknown>;
        };
        if (typeof probe.getJob === 'function') await probe.getJob(`ping-${randomUUID()}`, queue);
        return `The queue backend answers (queue ${JSON.stringify(queue)}).`;
      } finally {
        await adapter.destroy?.().catch(() => {});
      }
    },
  };
}
