import { currentTraceId } from '../context_accessor.js';
import { type Entry, type RecordInput, resolveCreatedAt, resolveEntryId } from '../entry.js';
import { resolveOrigin } from '../origin_scope.js';
import { runAsTelescopeWork } from '../self_scope.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import {
  type ResolvedBufferOptions,
  resolveBufferOptions,
  serverPrefix,
  type TenantBufferOptions,
} from './config.js';
import { readToken, resetToken, type TenantTokenSource } from './verify.js';
import { APP_HEADER, WIRE_VERSION, type WireEntry } from './wire.js';

/** What a {@link RemoteTelescopeStore} has done so far. */
export interface RemoteStoreStats {
  /** Entries waiting to be sent. */
  buffered: number;
  /** Entries the server accepted. */
  sent: number;
  /** Entries dropped because the buffer was full (oldest first) or could not be serialized. */
  dropped: number;
  /** Entries the server refused as invalid (never retried). */
  rejected: number;
  /** Consecutive failed sends (0 once a send succeeds). */
  failures: number;
  /** The last failure, one line. */
  lastError: string | null;
  /** Epoch ms of the last successful send. */
  lastSuccessAt: number | null;
  /** Epoch ms before which no send is attempted (backoff). */
  nextAttemptAt: number;
}

/** Options of a {@link RemoteTelescopeStore}. */
export interface RemoteTelescopeStoreOptions {
  url: string;
  partition: string;
  token: TenantTokenSource;
  buffer?: TenantBufferOptions;
  /** Also record every entry here (and read from it), so the app's own console keeps working. */
  tee?: TelescopeStore | null;
  /** Injectable `fetch` (tests). Defaults to the global. */
  fetch?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Pending {
  json: string;
  bytes: number;
}

const OPTIONAL_READS = ['listTraceIds', 'countByBucket', 'countFamilies', 'countTags'] as const;

/** Every remote store built in this process (the provider flushes them at shutdown). */
export const activeRemoteStores = new Set<RemoteTelescopeStore>();

/**
 * A telescope store that sends every entry to a telescope server. `record()` never waits on the
 * network: entries go to a bounded buffer that is sent in batches on a timer, with exponential
 * backoff while the server is unreachable. When the buffer is full the oldest entries are dropped
 * (and counted). Reads answer from `tee` when one is set, else nothing.
 */
export class RemoteTelescopeStore implements TelescopeStore {
  private readonly prefix: string;
  private readonly options: ResolvedBufferOptions;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly tee: TelescopeStore | null;
  private buffer: Pending[] = [];
  private sequence = 0;
  private inflight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchSize: number;
  private readonly counters = {
    sent: 0,
    dropped: 0,
    rejected: 0,
    failures: 0,
    lastError: null as string | null,
    lastSuccessAt: null as number | null,
    nextAttemptAt: 0,
  };

  constructor(private readonly config: RemoteTelescopeStoreOptions) {
    this.prefix = serverPrefix(config.url);
    this.options = resolveBufferOptions(config.buffer);
    this.batchSize = this.options.batchSize;
    this.doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? Date.now;
    this.tee = config.tee ?? null;
    if (this.tee !== null) {
      const self = this as unknown as Record<string, unknown>;
      const inner = this.tee as unknown as Record<string, unknown>;
      for (const name of OPTIONAL_READS) {
        const method = inner[name];
        if (typeof method === 'function') self[name] = method.bind(this.tee);
      }
    }
  }

  /** Start the send timer (unref'd: it never keeps the process alive). */
  start(): this {
    if (this.timer === null) {
      this.timer = setInterval(() => void this.tick(), this.options.flushIntervalMs);
      this.timer.unref?.();
      activeRemoteStores.add(this);
    }
    return this;
  }

  /** Stop the send timer. Buffered entries stay buffered; call {@link flush} first to send them. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    activeRemoteStores.delete(this);
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    const entry = this.tee !== null ? await this.tee.record(input) : this.localEntry(input);
    this.enqueue(entry as Entry);
    return entry;
  }

  private localEntry<TContent>(input: RecordInput<TContent>): Entry<TContent> {
    return {
      id: resolveEntryId(input.id),
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: input.content,
      tags: input.tags ?? [],
      sequence: this.sequence++,
      durationMs: input.durationMs ?? null,
      origin: resolveOrigin(input.origin),
      traceId: input.traceId !== undefined ? input.traceId : currentTraceId(),
      createdAt: resolveCreatedAt(input.createdAt, this.now()),
    };
  }

  private enqueue(entry: Entry): void {
    const wire: WireEntry = {
      id: entry.id,
      type: entry.type,
      familyHash: entry.familyHash,
      content: entry.content,
      tags: entry.tags,
      durationMs: entry.durationMs,
      origin: entry.origin,
      traceId: entry.traceId,
      createdAt: entry.createdAt.toISOString(),
    };
    let json: string;
    try {
      json = JSON.stringify(wire);
    } catch {
      this.counters.dropped += 1;
      return;
    }
    this.buffer.push({ json, bytes: Buffer.byteLength(json) });
    this.trim();
    if (this.buffer.length >= this.batchSize) queueMicrotask(() => void this.tick());
  }

  /** Drop the oldest entries past the buffer cap. */
  private trim(): void {
    const over = this.buffer.length - this.options.maxEntries;
    if (over > 0) {
      this.buffer.splice(0, over);
      this.counters.dropped += over;
    }
  }

  /** One send attempt, unless one is running or the backoff has not elapsed. */
  private async tick(): Promise<void> {
    if (this.inflight !== null || this.buffer.length === 0) return;
    if (this.now() < this.counters.nextAttemptAt) return;
    await this.sendNext();
  }

  /**
   * Send everything buffered now, ignoring the backoff. Resolves when the buffer is empty or a
   * send failed. Used at shutdown and by tests.
   */
  async flush(): Promise<void> {
    if (this.inflight !== null) await this.inflight;
    while (this.buffer.length > 0) {
      if (!(await this.sendNext())) return;
    }
  }

  private sendNext(): Promise<boolean> {
    const run = this.sendBatch().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Take the next batch, send it; `true` on success. */
  private async sendBatch(): Promise<boolean> {
    const batch: Pending[] = [];
    let bytes = 0;
    while (batch.length < this.batchSize && this.buffer.length > 0) {
      const next = this.buffer[0] as Pending;
      if (batch.length > 0 && bytes + next.bytes > this.options.maxBatchBytes) break;
      batch.push(next);
      bytes += next.bytes;
      this.buffer.shift();
    }
    if (batch.length === 0) return true;
    const body = `{"version":${WIRE_VERSION},"entries":[${batch.map((p) => p.json).join(',')}]}`;

    let status: number;
    try {
      const token = await readToken(this.config.token);
      const response = await runAsTelescopeWork(() =>
        this.doFetch(`${this.prefix}/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            [APP_HEADER]: this.config.partition,
          },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        }),
      );
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      return this.failed(batch, error instanceof Error ? error.message : String(error));
    }

    if (status >= 200 && status < 300) {
      this.counters.sent += batch.length;
      this.counters.failures = 0;
      this.counters.lastError = null;
      this.counters.lastSuccessAt = this.now();
      this.counters.nextAttemptAt = 0;
      this.batchSize = Math.min(this.options.batchSize, this.batchSize * 2);
      return true;
    }
    if (status === 413 && batch.length > 1) {
      // Too big for the server: send smaller batches from now on.
      this.batchSize = Math.max(1, Math.floor(batch.length / 2));
      this.requeue(batch);
      return true;
    }
    if (status === 400 || status === 413 || status === 422) {
      this.counters.rejected += batch.length;
      this.counters.lastError = `the server refused ${batch.length} entries (${status})`;
      return true;
    }
    if (status === 401 || status === 403) resetToken(this.config.token);
    return this.failed(batch, `the server answered ${status}`);
  }

  private requeue(batch: Pending[]): void {
    this.buffer = batch.concat(this.buffer);
    this.trim();
  }

  private failed(batch: Pending[], message: string): false {
    this.requeue(batch);
    this.counters.failures += 1;
    this.counters.lastError = message;
    const { baseMs, maxMs } = this.options.retry;
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(this.counters.failures - 1, 30));
    // ±20% jitter so many apps coming back at once do not retry in lockstep.
    this.counters.nextAttemptAt = this.now() + Math.round(delay * (0.8 + Math.random() * 0.4));
    return false;
  }

  stats(): RemoteStoreStats {
    return { buffered: this.buffer.length, ...this.counters };
  }

  get(id: string): Promise<Entry | null> {
    return this.tee !== null ? this.tee.get(id) : Promise.resolve(null);
  }

  list(query?: EntryQuery): Promise<Entry[]> {
    return this.tee !== null ? this.tee.list(query) : Promise.resolve([]);
  }

  count(): Promise<number> {
    return this.tee !== null ? this.tee.count() : Promise.resolve(0);
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.tee !== null ? this.tee.prune(olderThan, keepLast) : Promise.resolve(0);
  }

  clear(): Promise<void> {
    return this.tee !== null ? this.tee.clear() : Promise.resolve();
  }
}
