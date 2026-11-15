import type { BatchOrigin, RecordInput } from '../entry.js';
import { type InstanceHeartbeat, normalizeHeartbeat } from '../fleet/heartbeat.js';
import { runAsTelescopeWork } from '../self_scope.js';
import type { TelescopeStore } from '../store.js';
import { type ResolvedIngestLimits, resolveIngestLimits } from './config.js';
import { type ConsumeOutcome, ENVELOPE_VERSION, type PushEnvelope } from './transports/types.js';
import {
  canIngest,
  resolveTenantVerifier,
  type TenantVerifierInput,
  type VerifiedTenant,
} from './verify.js';
import type { IngestResult } from './wire.js';

/** A framework-free ingest request: what the route reads off the HTTP request. */
export interface IngestRequest {
  /** The bearer token. */
  token?: string | undefined;
  /** `x-telescope-app` (advisory: the token decides). */
  app?: string | undefined;
  /** `content-length`, when sent. */
  contentLength?: number | undefined;
  /** The parsed JSON body. */
  body: unknown;
}

/** What the route answers. */
export interface IngestResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Options of {@link createIngestHandler}. */
export interface IngestHandlerOptions {
  verifyTenant: TenantVerifierInput;
  /** The store entries are written to (resolved per request: telescope boots after this). */
  store: () => TelescopeStore | null;
  limits?: ResolvedIngestLimits;
  /**
   * Called with the heartbeat a batch carries (`heartbeat` next to `entries`), with the sender as
   * its token names it. A failure here never fails the batch.
   */
  onHeartbeat?: (verified: VerifiedTenant, heartbeat: InstanceHeartbeat) => Promise<void> | void;
  /** Called with a refused request, for a log line. */
  onRefused?: (reason: string, verified: VerifiedTenant | null) => void;
}

const ORIGINS: readonly BatchOrigin[] = ['http', 'queue', 'schedule', 'cli', 'manual'];
const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A sender's entry id: printable, short enough to namespace by app (`<app>:<id>`). */
const ID_RE = /^[\x21-\x7e]{1,128}$/;
/** Tags only the server sets: anything a sender puts there is dropped. */
const RESERVED_TAG_RE = /^(app|env):/;
/** An app name from a token: short and printable, so `<app>:<id>` fits the store's id limit. */
export const PARTITION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A bounded set of recently stored ids per app (insertion order = eviction order). */
class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(key: string): boolean {
    return this.ids.has(key);
  }
  add(key: string): void {
    this.ids.add(key);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value as string;
      this.ids.delete(oldest);
    }
  }
}

function deny(status: number, error: string): IngestResponse {
  return { status, body: { error } };
}

const isNullableString = (value: unknown, max: number) =>
  value === null || value === undefined || (typeof value === 'string' && value.length <= max);

/** The validated, server-tagged form of one wire entry, or `null` when it is invalid. */
function normalize(
  raw: unknown,
  verified: VerifiedTenant,
  limits: ResolvedIngestLimits,
): {
  id: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  durationMs: number | null;
  origin: BatchOrigin;
  traceId: string | null;
  createdAt?: string;
} | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  if (e.createdAt !== undefined && e.createdAt !== null && typeof e.createdAt !== 'string') {
    return null;
  }
  if (typeof e.type !== 'string' || !TYPE_RE.test(e.type)) return null;
  if (!isNullableString(e.familyHash, 512) || !isNullableString(e.traceId, 128)) return null;
  if (
    e.durationMs !== null &&
    e.durationMs !== undefined &&
    (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0)
  ) {
    return null;
  }
  const tags = e.tags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.length > 100 ||
    !tags.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 256)
  ) {
    return null;
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(e.content ?? null));
  } catch {
    return null;
  }
  if (size > limits.maxEntryBytes) return null;
  const own = [`app:${verified.partition}`];
  if (verified.environment !== undefined && verified.environment !== '') {
    own.push(`env:${verified.environment}`);
  }
  const kept = (tags as string[]).filter((t) => !RESERVED_TAG_RE.test(t));
  return {
    id: e.id,
    type: e.type,
    familyHash: (e.familyHash as string | null | undefined) ?? null,
    content: e.content ?? null,
    tags: [...new Set([...kept, ...own])],
    durationMs: (e.durationMs as number | null | undefined) ?? null,
    origin: ORIGINS.includes(e.origin as BatchOrigin) ? (e.origin as BatchOrigin) : 'manual',
    traceId: (e.traceId as string | null | undefined) ?? null,
    // When the app recorded it. Telescope keeps it, taking a far-future or invalid one as now.
    ...(typeof e.createdAt === 'string' ? { createdAt: e.createdAt } : {}),
  };
}

/**
 * The server half: verify the sender's token, validate and size-limit its batch, and write each
 * entry into the server's telescope store tagged `app:<partition>` (and `env:<environment>`), where
 * partition and environment come from the token. A batch sent twice is stored once.
 */
export function createIngestHandler(options: IngestHandlerOptions) {
  const verify = resolveTenantVerifier(options.verifyTenant);
  const limits = options.limits ?? resolveIngestLimits();
  const recent = new RecentIds(limits.dedupeWindow);
  /** Broker message ids already stored (`<app>:<message id>`): a redelivery is acknowledged. */
  const recentMessages = new RecentIds(Math.max(1000, Math.floor(limits.dedupeWindow / 10)));

  async function authenticate(
    request: Pick<IngestRequest, 'token' | 'app'>,
  ): Promise<VerifiedTenant | IngestResponse> {
    if (!request.token) return deny(401, 'unauthenticated');
    let verified: VerifiedTenant | null;
    try {
      verified = await verify({
        token: request.token,
        partition: request.app,
        tenant: request.app,
      });
    } catch {
      return deny(503, 'the token could not be verified right now');
    }
    if (verified === null) {
      options.onRefused?.('invalid token', null);
      return deny(401, 'unauthenticated');
    }
    if (verified.expiresAt !== undefined && verified.expiresAt <= Date.now()) {
      return deny(401, 'unauthenticated');
    }
    if (!PARTITION_RE.test(verified.partition)) {
      options.onRefused?.('the token names an invalid app (1-64 of A-Z a-z 0-9 _ . -)', verified);
      return deny(403, 'forbidden');
    }
    if (!canIngest(verified.capabilities)) {
      options.onRefused?.('missing the telescope:ingest capability', verified);
      return deny(403, 'forbidden');
    }
    return verified;
  }

  /** Validate a sender's batch and write it, tagged with the verified app. */
  async function storeBatch(
    verified: VerifiedTenant,
    rawBody: unknown,
    measure: boolean,
  ): Promise<IngestResponse> {
    const body = rawBody as { version?: unknown; entries?: unknown; heartbeat?: unknown } | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.entries)) {
      return deny(400, 'expected { version: 1, entries: [...] }');
    }
    if (body.version !== undefined && body.version !== 1) {
      return deny(400, `unsupported version ${String(body.version)}`);
    }
    // Without a content-length (chunked), measure the parsed body against the same cap.
    if (measure) {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(body));
      } catch {
        return deny(400, 'the body cannot be read as JSON');
      }
      if (bytes > limits.maxBodyBytes) {
        return deny(413, `the body is over ${limits.maxBodyBytes} bytes`);
      }
    }
    if (body.entries.length > limits.maxEntries) {
      return deny(413, `at most ${limits.maxEntries} entries per batch`);
    }
    if (body.heartbeat !== undefined && options.onHeartbeat !== undefined) {
      const heartbeat = normalizeHeartbeat(body.heartbeat);
      if (heartbeat !== null) {
        try {
          await runAsTelescopeWork(async () => options.onHeartbeat?.(verified, heartbeat));
        } catch {
          // The fleet store is down: the entries are still taken.
        }
      }
    }
    const store = options.store();
    if (store === null) return deny(503, 'telescope is not running on this server');

    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 };
    for (const raw of body.entries) {
      const entry = normalize(raw, verified, limits);
      if (entry === null) {
        result.rejected += 1;
        continue;
      }
      const key = `${verified.partition}\u0000${entry.id}`;
      if (recent.has(key)) {
        result.duplicates += 1;
        continue;
      }
      // Stored as `<app>:<id>`: the app's own id, which no other app can collide with. The store
      // skips an id it already holds, so a retry is stored once even after a restart.
      const input: RecordInput & { id: string; createdAt?: string } = {
        ...entry,
        id: `${verified.partition}:${entry.id}`,
      };
      // Telescope's own work: nothing the write causes (its INSERT) is recorded again.
      try {
        await runAsTelescopeWork(() => store.record(input));
      } catch {
        // The store is down: the sender retries the batch, and what was stored is deduped.
        return deny(503, 'the store could not write the entries right now');
      }
      recent.add(key);
      result.accepted += 1;
    }
    return { status: 202, body: { ...result } };
  }

  return {
    limits,

    /** `POST <path>/ingest`. */
    async ingest(request: IngestRequest): Promise<IngestResponse> {
      if (request.contentLength !== undefined && request.contentLength > limits.maxBodyBytes) {
        return deny(413, `the body is over ${limits.maxBodyBytes} bytes`);
      }
      const auth = await authenticate(request);
      if ('status' in auth) return auth;
      return storeBatch(auth, request.body, request.contentLength === undefined);
    },

    /**
     * One broker message (the envelope JSON a tenant's `transport` sent): the same checks as the
     * HTTP route, the token verified on every message, the app taken from the token. Says whether
     * to acknowledge it, deliver it again, or dead-letter it.
     */
    async message(raw: string): Promise<ConsumeOutcome> {
      const dead = (reason: string, verified: VerifiedTenant | null = null): ConsumeOutcome => {
        options.onRefused?.(reason, verified);
        return { kind: 'dead', reason };
      };
      if (Buffer.byteLength(raw) > limits.maxBodyBytes) {
        return dead(`the message is over ${limits.maxBodyBytes} bytes`);
      }
      let envelope: Partial<PushEnvelope>;
      try {
        envelope = JSON.parse(raw) as Partial<PushEnvelope>;
      } catch {
        return dead('the message is not JSON');
      }
      if (envelope === null || typeof envelope !== 'object' || envelope.v !== ENVELOPE_VERSION) {
        return dead('the message is not a telescope batch (v: 1)');
      }
      if (typeof envelope.id !== 'string' || !ID_RE.test(envelope.id)) {
        return dead('the message has no valid id');
      }
      if (typeof envelope.token !== 'string' || envelope.token === '') {
        return dead('the message carries no token');
      }
      const auth = await authenticate({
        token: envelope.token,
        app: typeof envelope.app === 'string' ? envelope.app : undefined,
      });
      if ('status' in auth) {
        if (auth.status === 503) return { kind: 'retry', reason: String(auth.body.error) };
        return dead(`refused (${auth.status} ${String(auth.body.error)})`);
      }
      const messageKey = `${auth.partition}:${envelope.id}`;
      if (recentMessages.has(messageKey)) return { kind: 'ok' };
      const response = await storeBatch(auth, envelope.batch, false);
      if (response.status === 503) return { kind: 'retry', reason: String(response.body.error) };
      if (response.status !== 202) return dead(String(response.body.error), auth);
      recentMessages.add(messageKey);
      return { kind: 'ok' };
    },

    /** The sender a request's token names, or the refusal to answer. */
    async caller(
      request: Pick<IngestRequest, 'token' | 'app'>,
    ): Promise<VerifiedTenant | IngestResponse> {
      return authenticate(request);
    },

    /** `GET <path>/whoami`: who the token says the sender is. */
    async whoami(request: Pick<IngestRequest, 'token' | 'app'>): Promise<IngestResponse> {
      const auth = await authenticate(request);
      if ('status' in auth) return auth;
      return {
        status: 200,
        body: {
          partition: auth.partition,
          ...(auth.environment !== undefined ? { environment: auth.environment } : {}),
        },
      };
    },
  };
}

export type IngestHandler = ReturnType<typeof createIngestHandler>;
