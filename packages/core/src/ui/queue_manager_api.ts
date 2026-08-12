import type {
  QueueActionName,
  QueueCapabilities,
  QueueJobDetail,
  QueueManager,
  QueueSummary,
} from '../watchers/queue_manager.js';
import type { UiHttpContext } from './http.js';

/** `POST <path>/api/queues/live/:queue/enqueue` request body. */
export interface EnqueueBody {
  name?: unknown;
  payload?: unknown;
}

/**
 * `GET/POST <path>/api/queues/live*` handlers over the OPTIONAL `queue-manager` watcher capability
 * (`src/watchers/queue_manager.ts`). Mirrors the shape of {@link ProfilesApi}/{@link DiagnosisApi}:
 * constructed from the runtime slot (`getTelescopeRuntime().queueManager`), degrading every route to
 * `404` when it's `null` (capability not enabled / `@adonisjs/queue` not installed).
 *
 * Unlike `nestjs-telescope`'s `TelescopeController` (which addresses N queue-manager DRIVERS by a
 * `:driver` route segment, since a Nest app can register several `QueueManager`s), AdonisJS has
 * exactly ONE `@adonisjs/queue` install per app, so there is exactly one {@link QueueManager} and no
 * `:driver` segment — `<path>/api/queues/live/:queue/...` rather than
 * `<path>/api/queues/live/:driver/:queue/...`.
 */
export class QueueManagerApi {
  constructor(private readonly manager: QueueManager | null) {}

  /** Whether the capability is enabled at all — surfaced on `GET <path>/api/meta`. */
  isConfigured(): boolean {
    return this.manager !== null;
  }

  /**
   * Whether the manager can perform `action` — prefers the precise `capabilities` advertisement
   * (see the {@link QueueManager} doc) and falls back to plain method presence when the driver
   * doesn't expose it.
   */
  private supports(action: QueueActionName): boolean {
    if (this.manager === null) return false;
    if (this.manager.capabilities !== undefined) return this.manager.capabilities.includes(action);
    // `QueueActionName` names exactly the `QueueManager` method that implements it (`'retry'` →
    // `.retry`, …), so this is the same "presence advertises capability" check the NestJS
    // `BullMqQueueManager`-shaped SPI uses — the fallback for a driver with no `capabilities` getter.
    return typeof this.manager[action] === 'function';
  }

  /** `GET <path>/api/queues/live` — configured queues (with counts) + capabilities. */
  async list(ctx: UiHttpContext, mutationsEnabled: boolean): Promise<unknown> {
    if (this.manager === null) return notConfigured(ctx);
    const queues: QueueSummary[] = await this.manager.listQueues();
    const actions = new Set<QueueActionName>();
    for (const summary of queues) for (const action of summary.actions) actions.add(action);
    const capabilities: QueueCapabilities = { mutationsEnabled, actions: [...actions] };
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: { queues, capabilities } });
  }

  /** `GET <path>/api/queues/live/:queue/jobs/:id` — one job, or 404. */
  async job(ctx: UiHttpContext, queue: string, id: string): Promise<unknown> {
    if (this.manager === null) return notConfigured(ctx);
    const job: QueueJobDetail | null = await this.manager.getJob(queue, id);
    if (job === null) return ctx.response.status(404).send({ error: 'No job with that id.' });
    return ctx.response.status(200).header('content-type', 'application/json').send({ data: job });
  }

  /**
   * `POST <path>/api/queues/live/:queue/jobs/:id/retry` — a MUTATION, so the caller (the provider)
   * must have already confirmed `queueActions.enabled`, mirroring `replayRequest`'s convention of
   * the provider owning the gate, not this class. `501` when the driver has no `retry` (mirrors the
   * NestJS sibling's `MethodNotAllowedException` for an unsupported action, without depending on an
   * HTTP-framework-specific exception type here).
   */
  async retry(ctx: UiHttpContext, queue: string, id: string): Promise<unknown> {
    if (this.manager === null) return notConfigured(ctx);
    if (!this.supports('retry') || !this.manager.retry) {
      return ctx.response
        .status(501)
        .send({ error: 'This queue adapter does not support retrying a job.' });
    }
    try {
      await this.manager.retry(queue, id);
    } catch (err) {
      return ctx.response.status(400).send({ error: asMessage(err) });
    }
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: { ok: true } });
  }

  /** `POST <path>/api/queues/live/:queue/enqueue` — dispatch a new job. `501` when unsupported. */
  async enqueue(ctx: UiHttpContext, queue: string, body: EnqueueBody): Promise<unknown> {
    if (this.manager === null) return notConfigured(ctx);
    if (!this.supports('enqueue') || !this.manager.enqueue) {
      return ctx.response
        .status(501)
        .send({ error: 'This queue adapter does not support enqueueing a job.' });
    }
    if (body === undefined || body === null || !('payload' in body)) {
      return ctx.response.status(400).send({ error: 'Body must include a "payload".' });
    }
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined;
    try {
      const data = await this.manager.enqueue(
        queue,
        body.payload,
        name !== undefined ? { name } : {},
      );
      return ctx.response.status(200).header('content-type', 'application/json').send({ data });
    } catch (err) {
      return ctx.response.status(400).send({ error: asMessage(err) });
    }
  }
}

function notConfigured(ctx: UiHttpContext): unknown {
  return ctx.response.status(404).send({
    error:
      'The live queue manager is not configured (enable the "queue-manager" watcher and set ' +
      'telescope_watchers.queueManager.queues).',
  });
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
