import { withoutToken } from './redis.js';
import {
  type ControlPlaneChannel,
  encodeEnvelope,
  errorMessage,
  type MessageHandler,
  type OutgoingBatch,
  type SendOutcome,
  type TelescopeTransport,
  type TenantChannel,
} from './types.js';

/** Options of `transports.bullmq()`. */
export interface BullmqTransportOptions {
  /** ioredis connection options or an ioredis instance, handed to BullMQ. */
  connection: unknown;
  /** BullMQ key prefix. Default `bull` (BullMQ's). */
  prefix?: string;
  /** The queue name. Default `telescope-ingest`. */
  queue?: string;
  /** Deliveries of one message before it stays in the failed set (the dead letters). Default 5. */
  maxAttempts?: number;
  /** Control plane: jobs handled at once. Default 1. */
  concurrency?: number;
}

/** The slice of the `bullmq` module the driver uses (injectable for tests). */
export interface BullmqModule {
  Queue: new (
    name: string,
    options: Record<string, unknown>,
  ) => {
    add(name: string, data: unknown, options?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
    getJobCounts(...types: string[]): Promise<Record<string, number>>;
  };
  Worker: new (
    name: string,
    processor: (job: {
      data: unknown;
      attemptsMade: number;
      opts?: { attempts?: number };
      updateData?(data: unknown): Promise<void>;
    }) => Promise<unknown>,
    options: Record<string, unknown>,
  ) => {
    close(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  UnrecoverableError: new (message: string) => Error;
}

const JOB_NAME = 'telescope.ingest';

async function loadBullmq(): Promise<BullmqModule> {
  const name = 'bullmq';
  try {
    return (await import(name)) as BullmqModule;
  } catch (error) {
    throw new Error(
      `[@adonis-agora/telescope] transports.bullmq() needs the bullmq package (npm i bullmq): ${errorMessage(error)}`,
    );
  }
}

/** Adds each batch as one job (BullMQ retries it with backoff on the control plane). */
export class BullmqTenantChannel implements TenantChannel {
  private readonly queue: InstanceType<BullmqModule['Queue']>;

  constructor(
    bullmq: BullmqModule,
    private readonly options: BullmqTransportOptions,
  ) {
    this.queue = new bullmq.Queue(options.queue ?? 'telescope-ingest', {
      connection: options.connection,
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    });
  }

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    try {
      await this.queue.add(
        JOB_NAME,
        { m: encodeEnvelope(batch) },
        {
          jobId: batch.id,
          attempts: this.options.maxAttempts ?? 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: { count: 10_000 },
        },
      );
      return { kind: 'ok' };
    } catch (error) {
      return { kind: 'failed', message: `bullmq refused the batch: ${errorMessage(error)}` };
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * A BullMQ worker. A poison message throws `UnrecoverableError` (straight to the failed set, the
 * dead letters); a transient failure throws, so BullMQ retries it with backoff.
 */
export class BullmqControlPlaneChannel implements ControlPlaneChannel {
  private worker: InstanceType<BullmqModule['Worker']> | null = null;

  constructor(
    private readonly bullmq: BullmqModule,
    private readonly options: BullmqTransportOptions,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async start(handler: MessageHandler): Promise<void> {
    const { UnrecoverableError } = this.bullmq;
    this.worker = new this.bullmq.Worker(
      this.options.queue ?? 'telescope-ingest',
      async (job) => {
        const data = job.data as { m?: unknown } | null;
        const raw = typeof data?.m === 'string' ? data.m : '';
        const outcome = await handler(raw);
        if (outcome.kind === 'ok') return null;
        const last = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
        // What stays in the failed set keeps no bearer token.
        if (outcome.kind === 'dead' || last) {
          await job.updateData?.({ m: withoutToken(raw) }).catch(() => {});
        }
        if (outcome.kind === 'dead') throw new UnrecoverableError(outcome.reason);
        throw new Error(outcome.reason);
      },
      {
        connection: this.options.connection,
        concurrency: this.options.concurrency ?? 1,
        ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      },
    );
    this.worker.on('error', (error) => this.onError(error));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }
}

/** The BullMQ driver. `bullmq` is imported only when this driver is selected. */
export function bullmqTransport(
  options: BullmqTransportOptions,
  load: () => Promise<BullmqModule> = loadBullmq,
): TelescopeTransport {
  if (options === null || typeof options !== 'object' || options.connection === undefined) {
    throw new Error('[@adonis-agora/telescope] transports.bullmq() needs a `connection`');
  }
  const queue = options.queue ?? 'telescope-ingest';
  return {
    driver: 'bullmq',
    describe: () => `bullmq queue ${JSON.stringify(queue)}`,
    tenant: async () => new BullmqTenantChannel(await load(), options),
    controlPlane: async (ctx) =>
      new BullmqControlPlaneChannel(await load(), options, (error) =>
        ctx.logger?.warn(`[@adonis-agora/telescope] bullmq: ${errorMessage(error)}`),
      ),
    ping: async () => {
      const bullmq = await load();
      const probe = new bullmq.Queue(queue, {
        connection: options.connection,
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      });
      try {
        // A read of the queue's counts: answers when Redis does (BullMQ waits forever otherwise).
        const counts = await Promise.race([
          probe.getJobCounts('waiting', 'failed'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('no answer in 5 s')), 5000).unref(),
          ),
        ]);
        return `Redis answers for BullMQ (queue ${JSON.stringify(queue)}: ${counts.waiting ?? 0} waiting, ${counts.failed ?? 0} dead-lettered).`;
      } finally {
        await probe.close().catch(() => {});
      }
    },
  };
}
