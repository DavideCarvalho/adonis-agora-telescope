import type { BatchOrigin, RecordInput } from '../entry.js';
import { runAsTelescopeWork } from '../self_scope.js';
import type { TelescopeStore } from '../store.js';
import { type ResolvedIngestLimits, resolveIngestLimits } from './config.js';
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
  /** Called with a refused request, for a log line. */
  onRefused?: (reason: string, verified: VerifiedTenant | null) => void;
}

const ORIGINS: readonly BatchOrigin[] = ['http', 'queue', 'schedule', 'cli', 'manual'];
const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A sender's entry id: printable, short enough to namespace by app (`<app>:<id>`). */
const ID_RE = /^[\x21-\x7e]{1,128}$/;
/** Tags only the server sets: anything a sender puts there is dropped. */
const RESERVED_TAG_RE = /^(app|env):/;

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
    if (!canIngest(verified.capabilities)) {
      options.onRefused?.('missing the telescope:ingest capability', verified);
      return deny(403, 'forbidden');
    }
    return verified;
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
      const verified = auth;

      const body = request.body as { version?: unknown; entries?: unknown } | null;
      if (body === null || typeof body !== 'object' || !Array.isArray(body.entries)) {
        return deny(400, 'expected { version: 1, entries: [...] }');
      }
      if (body.version !== undefined && body.version !== 1) {
        return deny(400, `unsupported version ${String(body.version)}`);
      }
      if (body.entries.length > limits.maxEntries) {
        return deny(413, `at most ${limits.maxEntries} entries per batch`);
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
        await runAsTelescopeWork(() => store.record(input));
        recent.add(key);
        result.accepted += 1;
      }
      return { status: 202, body: { ...result } };
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
