import type { ClientErrorHttpContext } from './ingestor.js';

/** Default per-IP requests/minute when `rateLimit.perMinute` is omitted. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** Default accepted body size (32 KB) when `maxBodyBytes` is omitted. */
export const DEFAULT_MAX_BODY_BYTES = 32_768;
/** Default route path the ingestion endpoint is mounted on. */
export const DEFAULT_CLIENT_ERRORS_PATH = '/telescope/client-errors';

/**
 * Public front-end error ingestion (`POST <path>`). When enabled, browsers
 * report errors directly to telescope, recorded as `client_exception` entries
 * through the normal pipeline (family-hash, `failed`/`client`/`user:<id>` tags,
 * sampling, prune, dashboard).
 *
 * DISABLED by default: a public, unauthenticated ingestion surface is opt-in.
 * Unlike the NestJS port (which always mounts the controller and 404s while
 * off), the AdonisJS provider only REGISTERS the route when `enabled` is `true`
 * — so a disabled endpoint genuinely does not exist and a probe can't tell it is
 * wired.
 *
 * Security knobs are all best-effort and PER-PROCESS: a byte cap
 * (`maxBodyBytes`), an in-memory per-IP token bucket (`rateLimit`), and an
 * `authorize` hook for session/header validation. Recording additionally honours
 * the overload guard's `paused` flag (sheds while the event loop lags).
 */
export interface ClientErrorsConfig {
  /** Master switch. Default `false` — no route is registered until enabled. */
  enabled?: boolean;
  /**
   * Route path the `POST` ingestion endpoint is mounted on via the AdonisJS
   * router. Default `'/telescope/client-errors'`.
   */
  path?: string;
  /**
   * Hard cap on the accepted request body size in bytes. A larger body is
   * rejected (413) BEFORE structural validation, so a hostile browser can't make
   * telescope validate a huge payload. Default `32_768` (32 KB).
   */
  maxBodyBytes?: number;
  /**
   * Per-IP token-bucket rate limit. `perMinute` requests are allowed per IP per
   * minute (default `60`); over the limit returns 429. The bucket map is bounded
   * and per-process, so in a multi-instance deployment the EFFECTIVE limit is
   * `perMinute × instances` — acceptable for abuse-dampening, not a hard quota.
   */
  rateLimit?: { perMinute?: number };
  /**
   * Optional gate that runs FIRST, before validation/rate-limiting. Return
   * `false` to reject with 403 — lets a host require a session cookie or a shared
   * header on the public endpoint. A throw is treated as a denial (fail closed)
   * and never crashes the request.
   */
  authorize?: (ctx: ClientErrorHttpContext) => boolean | Promise<boolean>;
}

/** The fully-resolved client-errors config the provider/ingestor act on. */
export interface ResolvedClientErrorsConfig {
  enabled: boolean;
  path: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  authorize?: (ctx: ClientErrorHttpContext) => boolean | Promise<boolean>;
}

/** Apply defaults to a (possibly absent) client-errors config block. */
export function resolveClientErrors(config?: ClientErrorsConfig): ResolvedClientErrorsConfig {
  return {
    enabled: config?.enabled ?? false,
    path: config?.path ?? DEFAULT_CLIENT_ERRORS_PATH,
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    rateLimitPerMinute: config?.rateLimit?.perMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    ...(config?.authorize !== undefined ? { authorize: config.authorize } : {}),
  };
}
