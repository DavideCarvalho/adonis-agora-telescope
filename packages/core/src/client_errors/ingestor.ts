import { EntryType, type RecordInput } from '../entry.js';
import { exceptionFamilyHash } from '../exception_family_hash.js';
import { getTelescopeRuntime } from '../registry.js';
import type { TelescopeStore } from '../store.js';
import type { ResolvedClientErrorsConfig } from './config.js';
import { ClientErrorRateLimiter } from './rate_limiter.js';
import {
  type ClientExceptionContent,
  userIdentityTag,
  validateClientErrorBody,
} from './validation.js';

/**
 * The minimal HTTP surface the ingestor reads/writes, kept deliberately
 * framework-light so the handler is unit-testable with a plain object (no
 * running AdonisJS server). An Adonis `HttpContext` satisfies this structurally
 * — `request.body()`, `request.header()`, `request.ip()`, and a `response` that
 * can set a status and send a body — so the provider passes the real `ctx`
 * straight through.
 */
export interface ClientErrorRequest {
  /** The parsed request body (Adonis `request.body()`). */
  body(): unknown;
  /** A single request header by (case-insensitive) name, or `undefined`. */
  header(name: string): string | undefined;
  /** The resolving client IP (Adonis `request.ip()`, which honours trust-proxy). */
  ip(): string | undefined;
}

/** The slice of an outbound response the ingestor writes. */
export interface ClientErrorResponse {
  /** Set the HTTP status code; returns `this` for chaining (Adonis-compatible). */
  status(code: number): ClientErrorResponse;
  /** Send a body (object → JSON, string → as-is). Terminal. */
  send(body: unknown): unknown;
}

/** A framework-light HTTP context: just the request + response slices above. */
export interface ClientErrorHttpContext {
  request: ClientErrorRequest;
  response: ClientErrorResponse;
}

/** Injectable seams so the ingestor is testable without the global runtime. */
export interface ClientErrorIngestorDeps {
  config: ResolvedClientErrorsConfig;
  /**
   * Fire-and-forget recorder. Wired by the provider to
   * `store.record(input)` with rejections swallowed. Injected (rather than the
   * store) so a test can assert exactly what would be recorded.
   */
  record: (input: RecordInput<ClientExceptionContent>) => void;
  /** Overload-shed seam. Defaults to the global runtime `paused` flag. */
  isPaused?: () => boolean;
  /** Wall-clock seam (ms) for the rate limiter. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Records the active telescope store's `record` as a fire-and-forget sink,
 * swallowing every failure — mirroring the watcher `safeRecord` contract so an
 * ingest request can never be broken (or blocked) by a failing store.
 */
export function storeRecorder(
  store: TelescopeStore,
): (input: RecordInput<ClientExceptionContent>) => void {
  return (input) => {
    try {
      void Promise.resolve(store.record(input)).catch((err) => reportError(err));
    } catch (err) {
      reportError(err);
    }
  };
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`telescope client-errors: failed to record entry: ${message}`);
}

/**
 * The framework-agnostic client-error ingestion handler. Mirrors the NestJS
 * `ClientErrorController.ingest` pipeline in idiomatic AdonisJS form — the
 * provider registers `POST <path>` and delegates to {@link handle}.
 *
 * Pipeline (each stage short-circuits): authorize hook → body byte cap (413) →
 * per-IP rate limit (429) → structural validation (400) → overload-shed check →
 * record as a `client_exception` entry and answer `204 No Content`.
 */
export class ClientErrorIngestor {
  private readonly config: ResolvedClientErrorsConfig;
  private readonly record: (input: RecordInput<ClientExceptionContent>) => void;
  private readonly isPaused: () => boolean;
  private readonly limiter: ClientErrorRateLimiter;
  /** One warn for an authorize-hook throw, so a flaky hook can't spam logs. */
  private warnedAuthorize = false;

  constructor(deps: ClientErrorIngestorDeps) {
    this.config = deps.config;
    this.record = deps.record;
    this.isPaused = deps.isPaused ?? (() => getTelescopeRuntime().paused);
    this.limiter = new ClientErrorRateLimiter({
      perMinute: this.config.rateLimitPerMinute,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  }

  async handle(ctx: ClientErrorHttpContext): Promise<unknown> {
    const config = this.config;

    // 1) authorize hook runs FIRST (before any work): a session/header gate.
    if (config.authorize !== undefined) {
      if (!(await this.runAuthorize(config.authorize, ctx))) {
        return ctx.response.status(403).send({ error: 'Forbidden' });
      }
    }

    // 2) body byte cap, BEFORE validation, so a huge payload is cheap to reject.
    const body = ctx.request.body();
    if (this.bodyByteSize(body) > config.maxBodyBytes) {
      return ctx.response.status(413).send({ error: 'Payload too large' });
    }

    // 3) per-IP rate limit (per-process, best-effort abuse dampening).
    const ip = this.clientIp(ctx);
    if (!this.limiter.tryConsume(ip)) {
      return ctx.response.status(429).send({ error: 'Rate limit exceeded' });
    }

    // 4) structural validation — never trust the body; no echo on failure.
    const validation = validateClientErrorBody(body);
    if (!validation.ok) {
      return ctx.response.status(400).send({ error: validation.reason });
    }

    // 5) overload shed: while the guard has paused ingestion, DROP the entry so
    //    a lagging event loop is never made worse — but still answer 204 so the
    //    browser treats it as accepted and does not retry-storm.
    if (this.isPaused()) {
      return ctx.response.status(204).send(null);
    }

    // 6) record through the normal pipeline: family-hash from name+message+top
    //    frame (mirrors server exceptions), and the composing tags.
    const content = validation.value;
    const tags = ['failed', 'client'];
    const userTag = userIdentityTag(content.user);
    if (userTag !== null) tags.push(userTag);

    this.record({
      type: EntryType.ClientException,
      familyHash: exceptionFamilyHash({
        name: content.name ?? '',
        message: content.message,
        stack: content.stack,
      }),
      tags,
      content: { ...content, clientIp: ip === 'unknown' ? null : ip },
    });

    return ctx.response.status(204).send(null);
  }

  /**
   * Run the host's authorize hook defensively: a throw is a DENIAL (fail closed)
   * and warn-logged once, so a buggy hook never 500s the public endpoint nor
   * floods the logs.
   */
  private async runAuthorize(
    authorize: NonNullable<ResolvedClientErrorsConfig['authorize']>,
    ctx: ClientErrorHttpContext,
  ): Promise<boolean> {
    try {
      return (await authorize(ctx)) === true;
    } catch (error) {
      if (!this.warnedAuthorize) {
        this.warnedAuthorize = true;
        console.warn(
          `telescope client-errors authorize hook threw; treating as denial. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return false;
    }
  }

  /**
   * Best-effort serialized byte size of the parsed body. The framework already
   * parsed JSON by the time we get here, so we re-serialize to measure bytes
   * (UTF-8) — a tight enough proxy for the wire size to reject oversized
   * payloads. A non-serializable body counts as 0 (it'll fail validation anyway).
   */
  private bodyByteSize(body: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
    } catch {
      return 0;
    }
  }

  /** The reporting client's IP via Adonis `request.ip()`, or `'unknown'`. */
  private clientIp(ctx: ClientErrorHttpContext): string {
    const ip = ctx.request.ip();
    return typeof ip === 'string' && ip.length > 0 ? ip : 'unknown';
  }
}
