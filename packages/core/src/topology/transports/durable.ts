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

/** The slice of an `@adonis-agora/durable` transport the driver uses. */
export interface DurableTransportLike {
  dispatch(task: {
    runId: string;
    seq: number;
    name: string;
    stepId: string;
    group: string;
    input: unknown;
    attempt: number;
  }): Promise<void>;
  handle?(name: string, fn: (input: unknown) => Promise<unknown>): void;
  deferConsumers?(): void;
  startConsumers?(): void;
  close?(): Promise<void>;
}

/** A durable `TransportFactory` (`transports.queue(...)` from `@adonis-agora/durable`). */
export type DurableTransportFactory = (ctx: {
  app: NonNullable<TransportContext['app']>;
}) => Promise<DurableTransportLike>;

/** Options of `transports.durable()`. */
export interface DurableTransportOptions {
  /**
   * Which durable transport carries the batches: a key of `transports` in `config/durable.ts`
   * (default that file's `transport`), or a durable transport factory.
   */
  transport?: string | DurableTransportFactory;
  /** Control plane: attempts at one message before it is dead-lettered. Default 5. */
  maxAttempts?: number;
}

/** The durable step name the batches are dispatched as. */
export const DURABLE_STEP = 'telescope.ingest';

async function resolveDurableTransport(
  options: DurableTransportOptions,
  ctx: TransportContext,
): Promise<DurableTransportLike> {
  const app = ctx.app;
  if (typeof options.transport === 'function') {
    return options.transport({ app } as Parameters<DurableTransportFactory>[0]);
  }
  if (!app) {
    throw new Error(
      '[@adonis-agora/telescope] transports.durable() needs the app (config/durable.ts)',
    );
  }
  const config = app.config.get<
    { transport?: unknown; transports?: Record<string, unknown> } | undefined
  >('durable', undefined);
  if (!config) {
    throw new Error(
      '[@adonis-agora/telescope] transports.durable() needs @adonis-agora/durable configured (config/durable.ts)',
    );
  }
  const name = options.transport ?? config.transport;
  if (typeof name !== 'string') {
    throw new Error(
      '[@adonis-agora/telescope] transports.durable() needs `transport` (a key of `transports` in config/durable.ts)',
    );
  }
  const factory = config.transports?.[name];
  if (typeof factory !== 'function') {
    throw new Error(
      `[@adonis-agora/telescope] transports.durable(): no transport "${name}" in config/durable.ts`,
    );
  }
  return (factory as DurableTransportFactory)({ app });
}

/** Dispatches each batch as a `telescope.ingest` durable step. */
export class DurableTenantChannel implements TenantChannel {
  private seq = 0;

  constructor(private readonly transport: DurableTransportLike) {
    // A tenant only produces: it never competes for durable's queues.
    transport.deferConsumers?.();
  }

  async send(batch: OutgoingBatch): Promise<SendOutcome> {
    try {
      await this.transport.dispatch({
        runId: `telescope:${batch.id}`,
        seq: this.seq++,
        name: DURABLE_STEP,
        stepId: batch.id,
        group: DURABLE_STEP,
        input: { m: encodeEnvelope(batch) },
        attempt: 1,
      });
      return { kind: 'ok' };
    } catch (error) {
      return { kind: 'failed', message: `durable refused the batch: ${errorMessage(error)}` };
    }
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

/**
 * Handles `telescope.ingest` steps. A transient failure is retried in place with backoff (up to
 * `maxAttempts`); a poison message, or one that keeps failing, is dead-lettered (logged and
 * counted) and the step completes, so durable never redelivers it forever.
 */
export class DurableControlPlaneChannel implements ControlPlaneChannel {
  constructor(
    private readonly transport: DurableTransportLike,
    private readonly maxAttempts: number,
    private readonly onDead: (reason: string) => void = () => {},
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ) {}

  async start(handler: MessageHandler): Promise<void> {
    if (typeof this.transport.handle !== 'function') {
      throw new Error(
        '[@adonis-agora/telescope] transports.durable(): this durable transport cannot run steps (no handle())',
      );
    }
    this.transport.handle(DURABLE_STEP, async (input) => {
      const raw = (input as { m?: unknown } | null)?.m;
      const message = typeof raw === 'string' ? raw : '';
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await handler(message).catch(
          (error: unknown) => ({ kind: 'retry', reason: errorMessage(error) }) as const,
        );
        if (outcome.kind === 'ok') return { ok: true };
        if (outcome.kind === 'dead' || attempt >= this.maxAttempts) {
          const reason = outcome.kind === 'dead' ? outcome.reason : `gave up: ${outcome.reason}`;
          this.onDead(reason);
          return { ok: false, deadLettered: reason };
        }
        await this.sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
      }
    });
    this.transport.startConsumers?.();
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

/** The durable driver: batches ride the app's durable transport as `telescope.ingest` steps. */
export function durableTransport(options: DurableTransportOptions = {}): TelescopeTransport {
  return {
    driver: 'durable',
    describe: () =>
      `durable step ${JSON.stringify(DURABLE_STEP)}${typeof options.transport === 'string' ? ` over transport ${JSON.stringify(options.transport)}` : ''}`,
    tenant: async (ctx) => new DurableTenantChannel(await resolveDurableTransport(options, ctx)),
    controlPlane: async (ctx) =>
      new DurableControlPlaneChannel(
        await resolveDurableTransport(options, ctx),
        options.maxAttempts ?? 5,
        (reason) =>
          ctx.logger?.warn(`[@adonis-agora/telescope] durable: dead-lettered a batch (${reason})`),
      ),
    ping: async (ctx) => {
      const transport = await resolveDurableTransport(options, ctx);
      transport.deferConsumers?.();
      await transport.close?.().catch(() => {});
      return `The durable transport for ${JSON.stringify(DURABLE_STEP)} can be built.`;
    },
  };
}
