import { timingSafeEqual } from 'node:crypto';

/** The resource URN a telescope server answers for (the token's `aud`). */
export const TELESCOPE_RESOURCE = 'urn:agora:telescope';

/** The capability a token needs to send entries. */
export const INGEST_CAPABILITY = 'telescope:ingest';

/**
 * The capability a token needs to send entries on behalf of other apps: an entry tagged
 * `app:<name>` is stored as `<name>`'s (plus `via:<sender>`). `telescope:ingest:relay:<name>`
 * allows that one app only; `telescope:ingest:relay:*`, `telescope:ingest:*`, `telescope:*` and `*`
 * allow every app. Implies `telescope:ingest`.
 */
export const RELAY_CAPABILITY = 'telescope:ingest:relay';

/**
 * What a telescope server trusts about a sender. Everything comes from the verified token, never
 * from the request: `authkitTenantVerifier` from `@adonis-agora/authkit-client` returns it.
 */
export interface VerifiedTenant {
  /** The app (partition). Every entry it sends is tagged `app:<partition>`. */
  partition: string;
  /** The environment, when the token has one. Entries are tagged `env:<environment>`. */
  environment?: string;
  /**
   * What the token may do, matched by {@link capabilityAllows} (wildcards accepted). Sending
   * entries needs `telescope:ingest`; sending them on behalf of other apps needs
   * `telescope:ingest:relay[:<app>]`.
   */
  capabilities: string[];
  /** The service-tenant client behind the token, when it says. */
  clientId?: string;
  /** Epoch ms after which the token is no longer accepted. */
  expiresAt?: number;
}

/** What a verifier receives. Only `token` is trusted, once verified. */
export interface TenantAuthRequest {
  /** The bearer token (or the shared secret). */
  token?: string | undefined;
  /** The app the sender claims (`x-telescope-app`). Advisory only. */
  partition?: string | undefined;
  /** Same as `partition` (the wire name other libs use). Advisory only. */
  tenant?: string | undefined;
}

/** The top-level `verifyTenant` contract. */
export type TenantVerifier = (
  request: TenantAuthRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/** A class instance implementing `verify`. */
export interface TenantVerifierObject {
  verify(request: TenantAuthRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/** A lazily imported verifier module: a verifier, a class, or an object with `verify`. */
export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier | TenantVerifierObject;
  tenantVerifier?: TenantVerifier | TenantVerifierObject;
}

/** The accepted forms: a function, a class instance, a class, or a lazy `() => import(...)`. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

function hasVerify(value: unknown): value is TenantVerifierObject {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function isVerifierClass(value: unknown): value is new () => TenantVerifierObject {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function'
  );
}

/**
 * Validates a verifier's answer. `null` refuses; `{ partition, capabilities }` accepts; anything
 * else throws, so a malformed answer is never taken for an accepted sender.
 */
export function checkVerifiedTenant(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const value = result as Partial<VerifiedTenant> & { tenant?: unknown };
  if (
    typeof value === 'object' &&
    typeof value.partition === 'string' &&
    value.partition.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    (value.environment === undefined || typeof value.environment === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'number')
  ) {
    return value as VerifiedTenant;
  }
  throw new TypeError(
    `[@adonis-agora/telescope] verifyTenant must return { partition: string, capabilities: string[] } or null${
      value && typeof result === 'object' && 'tenant' in value
        ? ' (it returned `tenant`; rename it to `partition`)'
        : ''
    }`,
  );
}

/**
 * Turns any `verifyTenant` form into the function the server calls: a function, an object with
 * `verify` (a class instance), a class, or a lazy import of one.
 */
export function resolveTenantVerifier(
  input: TenantVerifierInput,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (isVerifierClass(input)) {
    let instance: TenantVerifierObject | undefined;
    return async (request) => {
      instance ??= new input();
      return checkVerifiedTenant(await instance.verify(request));
    };
  }
  if (hasVerify(input)) {
    return async (request) => checkVerifiedTenant(await input.verify(request));
  }
  if (typeof input !== 'function') {
    throw new TypeError(
      '[@adonis-agora/telescope] `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  const fn = input as (request: TenantAuthRequest) => unknown;
  let lazy: Promise<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>> | undefined;
  return async (request) => {
    if (lazy) return (await lazy)(request);
    const result = await fn(request);
    const exported =
      result && typeof result === 'object' && 'default' in (result as Record<string, unknown>)
        ? (result as TenantVerifierModule).default
        : undefined;
    const named =
      exported ??
      (result && typeof result === 'object'
        ? ((result as TenantVerifierModule).tenantVerifier ??
          (result as TenantVerifierModule).verify)
        : undefined);
    if (named !== undefined) {
      lazy = Promise.resolve(resolveTenantVerifier(named as TenantVerifierInput));
      return (await lazy)(request);
    }
    return checkVerifiedTenant(result);
  };
}

/**
 * Whether a token holding `granted` may do `required`. Mirrors the Agora-wide capability rule:
 * capabilities are compared segment by segment (split on `:`); a granted `*` segment matches
 * exactly one segment, and a grant ending in a `*` segment also matches any number of further
 * segments. So `*` allows everything, `telescope:*` everything telescope, and
 * `telescope:ingest:relay:*` relaying for every app. Otherwise the shapes must be equal. Empty or
 * non-string grants are ignored.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      const segment = have[index];
      if (segment === '*') {
        if (index >= want.length) {
          matched = false;
          break;
        }
        continue;
      }
      if (index >= want.length || segment !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A trailing `*` covers the rest; otherwise the shapes must have the same length.
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}

/** Whether `capabilities` allow sending entries (relaying for other apps implies it). */
export function canIngest(capabilities: readonly string[]): boolean {
  return capabilityAllows(capabilities, INGEST_CAPABILITY) || relayScope(capabilities) !== null;
}

/** App names, as `PARTITION_RE`: anything else could never match an entry's app. */
const APP_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The apps `capabilities` may relay entries for: `'*'` (`telescope:ingest:relay`, or any wildcard
 * covering every app such as `telescope:ingest:relay:*`, `telescope:*` or `*`), the apps named by
 * `telescope:ingest:relay:<app>`, or `null` (none).
 */
export function relayScope(capabilities: readonly string[]): '*' | string[] | null {
  if (
    capabilityAllows(capabilities, RELAY_CAPABILITY) ||
    capabilityAllows(capabilities, `${RELAY_CAPABILITY}:*`)
  ) {
    return '*';
  }
  const apps: string[] = [];
  for (const capability of capabilities) {
    if (typeof capability !== 'string') continue;
    const segments = capability.split(':');
    if (segments.length !== 4) continue;
    const app = segments[3] as string;
    if (APP_NAME_RE.test(app) && capabilityAllows([capability], `${RELAY_CAPABILITY}:${app}`)) {
      apps.push(app);
    }
  }
  return apps.length > 0 ? [...new Set(apps)] : null;
}

/** Whether a {@link relayScope} allows relaying entries for `app`. */
export function canRelayFor(scope: '*' | readonly string[] | null, app: string): boolean {
  return scope === '*' || scope?.includes(app) === true;
}

/** Constant-time comparison that does not leak the length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** One app's shared secret, with what it may do. */
export interface SharedSecretTenant {
  secret: string;
  /** Default `['telescope:ingest']`. */
  capabilities?: string[];
  /** Tag this app's entries `env:<environment>`. */
  environment?: string;
}

/**
 * One shared secret per app, compared in constant time, for setups without authkit. The sender
 * names its app with `x-telescope-app`; the secret proves it.
 */
export function sharedSecretVerifier(options: {
  partitions: Record<string, string | SharedSecretTenant>;
}): TenantVerifier {
  return (request) => {
    const app = request.partition ?? request.tenant;
    if (!request.token || !app) return null;
    if (!Object.hasOwn(options.partitions, app)) return null;
    const entry = options.partitions[app];
    if (entry === undefined) return null;
    const config = typeof entry === 'string' ? { secret: entry } : entry;
    if (typeof config.secret !== 'string' || config.secret === '') return null;
    if (!sameSecret(request.token, config.secret)) return null;
    return {
      partition: app,
      capabilities: config.capabilities ?? [INGEST_CAPABILITY],
      ...(config.environment !== undefined ? { environment: config.environment } : {}),
    };
  };
}

/** Where a tenant's token comes from: a literal, a function, or an object with `get()`. */
export type TenantTokenSource =
  | string
  | (() => string | Promise<string>)
  | { get(): string | Promise<string> };

/** Read the current token from a {@link TenantTokenSource}. */
export async function readToken(source: TenantTokenSource): Promise<string> {
  if (typeof source === 'string') return source;
  if (typeof source === 'function') return await source();
  return await source.get();
}

/** Ask a token source to drop its cached token (authkit's `reset()`), when it can. */
export function resetToken(source: TenantTokenSource): void {
  const reset = (source as { reset?: unknown }).reset;
  if (typeof reset === 'function') {
    try {
      (reset as () => void).call(source);
    } catch {
      // A source that cannot reset fetches a fresh token on its own.
    }
  }
}
