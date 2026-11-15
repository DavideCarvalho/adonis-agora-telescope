/**
 * In-memory stand-ins for the brokers the transports talk to: just enough of each API for the
 * drivers, with a `down` switch to simulate an outage.
 */
import type {
  BullmqModule,
  DurableTransportLike,
  QueueAdapterLike,
  QueueJobData,
  RedisCallClient,
} from '../../src/index.js';

/** An `@adonisjs/queue` adapter: jobs per queue, failed jobs kept (the dead letters). */
export class FakeQueueAdapter implements QueueAdapterLike {
  down = false;
  readonly queues = new Map<string, QueueJobData[]>();
  readonly failed: Array<{ job: QueueJobData; error?: string }> = [];
  readonly completed: string[] = [];
  /** Added to `Date.now()` (simulates time passing for delayed retries). */
  clockOffset = 0;
  private readonly active = new Map<string, QueueJobData>();
  private readonly availableAt = new Map<string, number>();

  private check() {
    if (this.down) throw new Error('ECONNREFUSED');
  }
  setWorkerId(): void {}
  async pushOn(queue: string, job: QueueJobData) {
    this.check();
    const list = this.queues.get(queue) ?? [];
    list.push(structuredClone(job));
    this.queues.set(queue, list);
  }
  async popFrom(queue: string) {
    this.check();
    const list = this.queues.get(queue) ?? [];
    const now = Date.now() + this.clockOffset;
    const at = list.findIndex((j) => (this.availableAt.get(j.id) ?? 0) <= now);
    if (at < 0) return null;
    const [job] = list.splice(at, 1) as [QueueJobData];
    this.active.set(job.id, job);
    return job;
  }
  async completeJob(id: string) {
    this.active.delete(id);
    this.completed.push(id);
  }
  async failJob(id: string, _queue: string, error?: Error) {
    const job = this.active.get(id);
    this.active.delete(id);
    if (job) this.failed.push({ job, ...(error ? { error: error.message } : {}) });
  }
  async retryJob(id: string, queue: string, retryAt?: Date) {
    const job = this.active.get(id);
    this.active.delete(id);
    if (retryAt) this.availableAt.set(id, retryAt.getTime() + this.clockOffset);
    if (job) this.queues.get(queue)?.push({ ...job, attempts: job.attempts + 1 });
  }
  async getJob() {
    this.check();
    return null;
  }
  size(queue: string) {
    return this.queues.get(queue)?.length ?? 0;
  }
}

interface StreamMessage {
  id: string;
  fields: string[];
}

/** A Redis with streams and consumer groups (the commands the redis driver sends). */
export class FakeRedis implements RedisCallClient {
  down = false;
  readonly streams = new Map<string, StreamMessage[]>();
  private readonly groups = new Map<
    string,
    {
      lastIndex: number;
      pending: Map<string, { consumer: string; deliveries: number; at: number }>;
    }
  >();
  private seq = 0;
  /** Added to `Date.now()` for the IDLE checks (simulates time passing). */
  clockOffset = 0;

  async call(command: string, ...args: Array<string | number>): Promise<unknown> {
    if (this.down) throw new Error('ECONNREFUSED');
    const a = args.map(String);
    const now = Date.now() + this.clockOffset;
    switch (command.toUpperCase()) {
      case 'PING':
        return 'PONG';
      case 'XADD': {
        const key = a[0] as string;
        const star = a.indexOf('*');
        const id = `${++this.seq}-0`;
        const list = this.streams.get(key) ?? [];
        list.push({ id, fields: a.slice(star + 1) });
        this.streams.set(key, list);
        return id;
      }
      case 'XGROUP': {
        const key = `${a[1]}|${a[2]}`;
        if (this.groups.has(key)) throw new Error('BUSYGROUP Consumer Group name already exists');
        if (!this.streams.has(a[1] as string)) this.streams.set(a[1] as string, []);
        this.groups.set(key, { lastIndex: 0, pending: new Map() });
        return 'OK';
      }
      case 'XREADGROUP': {
        const [, group, consumer, , count, , key] = a as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        const g = this.groups.get(`${key}|${group}`);
        if (!g) throw new Error('NOGROUP');
        const list = this.streams.get(key) ?? [];
        const fresh = list.slice(g.lastIndex, g.lastIndex + Number(count));
        g.lastIndex += fresh.length;
        if (fresh.length === 0) return null;
        for (const m of fresh) g.pending.set(m.id, { consumer, deliveries: 1, at: now });
        return [[key, fresh.map((m) => [m.id, m.fields])]];
      }
      case 'XPENDING': {
        const [key, group, , idle] = a as [string, string, string, string];
        const g = this.groups.get(`${key}|${group}`);
        return [...(g?.pending ?? [])]
          .filter(([, p]) => now - p.at >= Number(idle))
          .map(([id, p]) => [id, p.consumer, now - p.at, p.deliveries]);
      }
      case 'XCLAIM': {
        const [key, group, consumer, , id] = a as [string, string, string, string, string];
        const p = this.groups.get(`${key}|${group}`)?.pending.get(id as string);
        const m = this.streams.get(key)?.find((x) => x.id === id);
        if (!p || !m) return [];
        p.consumer = consumer;
        p.deliveries += 1;
        p.at = now;
        return [[m.id, m.fields]];
      }
      case 'XACK': {
        const [key, group, id] = a as [string, string, string];
        this.groups.get(`${key}|${group}`)?.pending.delete(id);
        return 1;
      }
      case 'XDEL':
        return 1;
      default:
        throw new Error(`fake redis: ${command} not implemented`);
    }
  }

  pending(key: string, group = 'telescope') {
    return this.groups.get(`${key}|${group}`)?.pending.size ?? 0;
  }
}

/** The `bullmq` module: a queue of jobs and a worker you drain by hand. */
export function fakeBullmq() {
  const jobs: Array<{
    id: string;
    data: unknown;
    attemptsMade: number;
    attempts: number;
    state: 'waiting' | 'done' | 'failed';
    failedReason?: string;
  }> = [];
  const state = { down: false };
  let processor: ((job: { data: unknown; attemptsMade: number }) => Promise<unknown>) | null = null;
  class UnrecoverableError extends Error {}
  class Queue {
    async getJobCounts() {
      if (state.down) throw new Error('ECONNREFUSED');
      return {
        waiting: jobs.filter((j) => j.state === 'waiting').length,
        failed: jobs.filter((j) => j.state === 'failed').length,
      };
    }
    async add(_name: string, data: unknown, options: Record<string, unknown> = {}) {
      if (state.down) throw new Error('ECONNREFUSED');
      const id = String(options.jobId);
      // BullMQ ignores a job id it already has.
      if (!jobs.some((j) => j.id === id)) {
        jobs.push({
          id,
          data: structuredClone(data),
          attemptsMade: 0,
          attempts: Number(options.attempts ?? 1),
          state: 'waiting',
        });
      }
    }
    async close() {}
  }
  class Worker {
    constructor(
      _name: string,
      fn: (job: { data: unknown; attemptsMade: number }) => Promise<unknown>,
    ) {
      processor = fn;
    }
    on() {
      return this;
    }
    async close() {}
  }
  /** Run every waiting job once, the way BullMQ would (retry or fail on a throw). */
  async function drain() {
    for (const job of jobs.filter((j) => j.state === 'waiting')) {
      try {
        await processor?.(job);
        job.state = 'done';
      } catch (error) {
        job.attemptsMade += 1;
        if (error instanceof UnrecoverableError || job.attemptsMade >= job.attempts) {
          job.state = 'failed';
          job.failedReason = (error as Error).message;
        }
      }
    }
  }
  const module = { Queue, Worker, UnrecoverableError } as unknown as BullmqModule;
  return { module, jobs, drain, state };
}

/** A durable transport: `dispatch` runs the handler registered under the step name. */
export class FakeDurableTransport implements DurableTransportLike {
  down = false;
  deferred = false;
  started = false;
  readonly handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  readonly dispatched: Array<{ name: string; input: unknown }> = [];
  readonly results: unknown[] = [];

  async dispatch(task: { name: string; input: unknown }) {
    if (this.down) throw new Error('broker down');
    this.dispatched.push({ name: task.name, input: structuredClone(task.input) });
  }
  handle(name: string, fn: (input: unknown) => Promise<unknown>) {
    this.handlers.set(name, fn);
  }
  deferConsumers() {
    this.deferred = true;
  }
  startConsumers() {
    this.started = true;
  }
  /** Deliver every dispatched task to its handler (another process' worker). */
  async deliver(to: FakeDurableTransport = this) {
    for (const task of this.dispatched.splice(0)) {
      this.results.push(await to.handlers.get(task.name)?.(task.input));
    }
  }
}
