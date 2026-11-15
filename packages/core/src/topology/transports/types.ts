/**
 * The tenant → control plane push channel: how a tenant's batches reach the control plane, and how
 * the control plane reads them. One {@link TelescopeTransport} is configured the same way on both
 * sides (`transport` in `config/telescope.ts`).
 */

/** What a driver needs from the app at boot (the booted `ApplicationService` fits). */
export interface TransportContext {
  app?: {
    container: { make(binding: unknown): Promise<unknown>; hasBinding?(binding: unknown): boolean };
    config: { get<T>(key: string, defaultValue?: T): T };
  };
  logger?: { warn(message: string): void; error?(message: string): void };
  /** The tenant buffer's per-send timeout (`tenant.buffer.timeoutMs`). */
  timeoutMs?: number;
}

/** What a tenant's send got back. */
export type SendOutcome =
  /** The control plane (or the broker) has the batch. */
  | { kind: 'ok' }
  /** The batch is too big for one message: send smaller batches. */
  | { kind: 'too-large' }
  /** The control plane refused the batch as invalid: never retried. */
  | { kind: 'rejected'; message: string }
  /** Not delivered: buffered again and retried with backoff. `auth` drops the cached token. */
  | { kind: 'failed'; message: string; auth?: boolean };

/** One batch as a tenant hands it to its channel. */
export interface OutgoingBatch {
  /** Unique per batch: the control plane drops a message id it already took from this app. */
  id: string;
  /** `{"version":1,"entries":[...]}`, already serialized. */
  body: string;
  /** Entries in the batch. */
  entries: number;
  /** The tenant's current token. */
  token: string;
  /** The tenant's app name (advisory: the token decides). */
  partition: string;
}

/** A tenant's sending half of a transport. */
export interface TenantChannel {
  send(batch: OutgoingBatch): Promise<SendOutcome>;
  /** Release connections (shutdown). */
  close?(): Promise<void>;
}

/** What the control plane does with one message. */
export type ConsumeOutcome =
  /** Stored (or a duplicate): acknowledge it. */
  | { kind: 'ok' }
  /** A transient failure (the store or the verifier is down): deliver it again later. */
  | { kind: 'retry'; reason: string }
  /** A poison message (bad token, malformed, too big): dead-letter it, never retry. */
  | { kind: 'dead'; reason: string };

/** Reads one raw message (the envelope JSON) and says what to do with it. */
export type MessageHandler = (raw: string) => Promise<ConsumeOutcome>;

/** The control plane's consuming half of a transport. */
export interface ControlPlaneChannel {
  /** Start consuming: every message goes through `handler`. */
  start(handler: MessageHandler): Promise<void>;
  /** Stop consuming and release connections. */
  close(): Promise<void>;
}

/** A configured transport: what `transports.*()` returns. Built lazily at boot. */
export interface TelescopeTransport {
  /** `http`, `queue`, `bullmq`, `redis` or `durable`. */
  readonly driver: TransportDriver;
  /** A one-line description for logs, status and the doctor (no secrets). */
  describe(): string;
  /** The tenant's sending half. Imports the driver's peer only now. */
  tenant(ctx: TransportContext): Promise<TenantChannel>;
  /**
   * The control plane's consuming half. `null` for `http`: the control plane's ingest routes take
   * those batches.
   */
  controlPlane(ctx: TransportContext): Promise<ControlPlaneChannel | null>;
  /** Whether the broker answers (the doctor). Throws with the reason when it does not. */
  ping(ctx: TransportContext): Promise<string>;
}

export type TransportDriver = 'http' | 'queue' | 'bullmq' | 'redis' | 'durable';

/** The wire version of a broker message envelope. */
export const ENVELOPE_VERSION = 1;

/**
 * A broker message: one batch plus who sent it. The control plane verifies `token` on every
 * message; app and environment come from the verified token, never from `app` or the queue name.
 */
export interface PushEnvelope {
  v: typeof ENVELOPE_VERSION;
  /** The batch id (dedupe: `<app>:<id>`). */
  id: string;
  /** The sender's app name (advisory). */
  app: string;
  token: string;
  /** When the tenant handed the batch to the broker (ISO 8601). */
  sentAt: string;
  /** `{ version: 1, entries: [...] }`. */
  batch: unknown;
}

/** The serialized envelope of a batch (the body is spliced in, not re-serialized). */
export function encodeEnvelope(batch: OutgoingBatch, now: Date = new Date()): string {
  const head = JSON.stringify({
    v: ENVELOPE_VERSION,
    id: batch.id,
    app: batch.partition,
    token: batch.token,
    sentAt: now.toISOString(),
  });
  return `${head.slice(0, -1)},"batch":${batch.body}}`;
}

/** The message's error, one line. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
