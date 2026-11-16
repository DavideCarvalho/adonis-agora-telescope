import { randomUUID } from 'node:crypto';
import { currentTraceId } from '../context_accessor.js';
import { type Entry, type RecordInput, resolveCreatedAt, resolveEntryId } from '../entry.js';
import type { InstanceHeartbeat, ShippingStats } from '../fleet/heartbeat.js';
import { resolveOrigin } from '../origin_scope.js';
import { runAsTelescopeWork } from '../self_scope.js';
import type { EntryQuery, TelescopeStore } from '../store.js';
import {
  type ResolvedBufferOptions,
  resolveBufferOptions,
  type TenantBufferOptions,
} from './config.js';
import type { ServerUrlInput } from './server_url.js';
import { HttpTenantChannel } from './transports/http.js';
import { errorMessage, type TenantChannel } from './transports/types.js';
import { readToken, resetToken, type TenantTokenSource } from './verify.js';
import { WIRE_VERSION, type WireEntry } from './wire.js';

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
  /**
   * The control plane's URL, for the HTTP channel (when no `channel` is given), or a function
   * resolving it on the first send.
   */
  url?: ServerUrlInput;
  /**
   * How batches are sent: a transport's tenant channel (or a promise of one, built at boot).
   * Default HTTP to `url`.
   */
  channel?: TenantChannel | Promise<TenantChannel>;
  partition: string;
  token: TenantTokenSource;
  /**
   * Relaying for other apps: an entry already tagged `app:<name>` is sent (and kept in `tee`) as
   * it is, and one without an `app:` tag is tagged `app:<partition>`. Off, tags are never touched
   * (the server drops a sender's `app:` tags unless its token may relay).
   */
  relay?: boolean;
  buffer?: TenantBufferOptions;
  /** Also record every entry here (and read from it), so the app's own console keeps working. */
  tee?: TelescopeStore | null;
  /** Injectable `fetch` for the default HTTP channel (tests). Defaults to the global. */
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
  private readonly options: ResolvedBufferOptions;
  private readonly channel: Promise<TenantChannel>;
  private readonly now: () => number;
  private readonly tee: TelescopeStore | null;
  private readonly startedAt: number;
  private buffer: Pending[] = [];
  /** The latest heartbeat not yet sent (only the newest matters): rides the next batch. */
  private pendingHeartbeat: string | null = null;
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
    this.options = resolveBufferOptions(config.buffer);
    this.batchSize = this.options.batchSize;
    if (config.channel !== undefined) {
      this.channel = Promise.resolve(config.channel);
    } else if (typeof config.url === 'string' || typeof config.url === 'function') {
      this.channel = Promise.resolve(
        new HttpTenantChannel(config.url, this.options.timeoutMs, config.fetch),
      );
    } else {
      throw new Error('[@adonis-agora/telescope] a remote store needs a `url` or a `channel`');
    }
    // A channel that fails to build (a missing peer) surfaces on each send, not as an unhandled rejection.
    this.channel.catch(() => {});
    this.now = config.now ?? Date.now;
    this.startedAt = this.now();
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

  /** Stop and release the channel's connections (shutdown, after {@link flush}). */
  async close(): Promise<void> {
    this.stop();
    try {
      await (await this.channel).close?.();
    } catch {
      // Nothing to release.
    }
  }

  async record<TContent>(input: RecordInput<TContent>): Promise<Entry<TContent>> {
    if (this.config.relay === true) input = this.ownAppTag(input);
    const entry = this.tee !== null ? await this.tee.record(input) : this.localEntry(input);
    this.enqueue(entry as Entry);
    return entry;
  }

  /** A relayer's own entry (no `app:` tag yet) gets `app:<partition>`; a relayed one is kept. */
  private ownAppTag<TContent>(input: RecordInput<TContent>): RecordInput<TContent> {
    const tags = input.tags ?? [];
    if (tags.some((tag) => tag.startsWith('app:'))) return input;
    return { ...input, tags: [...tags, `app:${this.config.partition}`] };
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

  /**
   * Send this instance's heartbeat with the next batch (alone when nothing is buffered). Only the
   * newest one is kept; it never takes a buffer slot, so a full buffer cannot hide the instance.
   */
  heartbeat(heartbeat: InstanceHeartbeat): void {
    try {
      this.pendingHeartbeat = JSON.stringify(heartbeat);
    } catch {
      return;
    }
    queueMicrotask(() => void this.tick());
  }

  /** The buffer's state as a heartbeat reports it. */
  shippingStats(): ShippingStats {
    const now = this.now();
    return {
      buffered: this.buffer.length,
      dropped: this.counters.dropped,
      sent: this.counters.sent,
      failures: this.counters.failures,
      lagMs:
        this.buffer.length === 0
          ? 0
          : Math.max(0, now - (this.counters.lastSuccessAt ?? this.startedAt)),
      lastError: this.counters.lastError,
    };
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
    if (this.inflight !== null) return;
    if (this.buffer.length === 0 && this.pendingHeartbeat === null) return;
    if (this.now() < this.counters.nextAttemptAt) return;
    await this.sendNext();
  }

  /**
   * Send everything buffered now, ignoring the backoff. Resolves when the buffer is empty or a
   * send failed. Used at shutdown and by tests.
   */
  async flush(): Promise<void> {
    if (this.inflight !== null) await this.inflight;
    while (this.buffer.length > 0 || this.pendingHeartbeat !== null) {
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
    const heartbeat = this.pendingHeartbeat;
    if (batch.length === 0 && heartbeat === null) return true;
    this.pendingHeartbeat = null;
    const body = `{"version":${WIRE_VERSION},"entries":[${batch.map((p) => p.json).join(',')}]${heartbeat !== null ? `,"heartbeat":${heartbeat}` : ''}}`;
    // A heartbeat that did not get through is sent again, unless a newer one replaced it.
    const keepHeartbeat = () => {
      if (heartbeat !== null && this.pendingHeartbeat === null) this.pendingHeartbeat = heartbeat;
    };

    let outcome: Awaited<ReturnType<TenantChannel['send']>>;
    try {
      const channel = await this.channel;
      // Telescope's own traffic too (an authkit token fetch): never recorded, never rewritten.
      const token = await runAsTelescopeWork(() => readToken(this.config.token));
      // Telescope's own traffic: the request/redis/queue watchers do not record it.
      outcome = await runAsTelescopeWork(() =>
        channel.send({
          id: randomUUID(),
          body,
          entries: batch.length,
          token,
          partition: this.config.partition,
        }),
      );
    } catch (error) {
      keepHeartbeat();
      return this.failed(batch, errorMessage(error));
    }

    if (outcome.kind === 'ok') {
      this.counters.sent += batch.length;
      this.counters.failures = 0;
      this.counters.lastError = null;
      this.counters.lastSuccessAt = this.now();
      this.counters.nextAttemptAt = 0;
      this.batchSize = Math.min(this.options.batchSize, this.batchSize * 2);
      return true;
    }
    if (outcome.kind === 'too-large' && batch.length > 1) {
      keepHeartbeat();
      // Too big for the server: send smaller batches from now on.
      this.batchSize = Math.max(1, Math.floor(batch.length / 2));
      this.requeue(batch);
      return true;
    }
    if (outcome.kind === 'rejected' || outcome.kind === 'too-large') {
      this.counters.rejected += batch.length;
      this.counters.lastError =
        outcome.kind === 'rejected'
          ? outcome.message
          : `the server refused ${batch.length} entries (413)`;
      return true;
    }
    if (outcome.auth) resetToken(this.config.token);
    keepHeartbeat();
    return this.failed(batch, outcome.message);
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
