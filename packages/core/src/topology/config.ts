import type { TenantTokenSource, TenantVerifierInput } from './verify.js';

/** The default route prefix of a control plane's ingest routes. */
export const DEFAULT_INGEST_PATH = '/_telescope/v1';

/**
 * Where this app's telescope sits:
 *
 * - `'standalone'` (default): the app keeps its own entries;
 * - `'control-plane'`: a central server that receives other apps' entries;
 * - `'tenant'`: the app sends its entries to a control plane.
 */
export type TelescopeTopology = 'standalone' | 'control-plane' | 'tenant';

/** Limits of a control plane's ingest route. */
export interface IngestLimits {
  /** Route prefix. Default `/_telescope/v1` (the route is `POST <path>/ingest`). */
  path?: string;
  /** Entries per batch. Default 1000. */
  maxEntries?: number;
  /** Bytes per request body. Default 2 MB. */
  maxBodyBytes?: number;
  /** Bytes per entry (its JSON). Default 256 KB. */
  maxEntryBytes?: number;
  /** How many recent entry ids per app are remembered to drop a batch sent twice. Default 100,000. */
  dedupeWindow?: number;
}

/** How a tenant buffers and sends its entries. */
export interface TenantBufferOptions {
  /** Entries kept while the server is unreachable; past it the oldest are dropped. Default 10,000. */
  maxEntries?: number;
  /** Entries per request. Default 200. */
  batchSize?: number;
  /** Bytes per request (the JSON body). Default 512 KB. */
  maxBatchBytes?: number;
  /** How often the buffer is sent. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Per-request timeout. Default 10,000 ms. */
  timeoutMs?: number;
  /** Backoff after a failed send: starts at `baseMs`, doubles, capped at `maxMs`. */
  retry?: { baseMs?: number; maxMs?: number };
}

/** `tenant` in `config/telescope.ts`: where a tenant sends its entries, and as which app. */
export interface TelescopeTenantOptions {
  /**
   * The control plane: its origin (`https://telescope.example.com`, the default path is added)
   * or the full prefix (`https://telescope.example.com/_telescope/v1`).
   */
  url: string;
  /** This app's name. The server takes it from the token; this names the app to a shared secret. */
  partition: string;
  /**
   * The token: `authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:telescope' })`,
   * a shared secret, or any `() => Promise<string>`.
   */
  token: TenantTokenSource;
  /**
   * Also keep every entry in this local store, so the app's own console shows them: a key of
   * `stores`, or `'memory'`. Default none (the app's console is empty; look at the server's).
   */
  local?: string;
  /** Buffering, batching and retries. */
  buffer?: TenantBufferOptions;
}

/** The topology keys of `config/telescope.ts`. */
export interface TelescopeTopologyConfig {
  topology?: TelescopeTopology;
  /**
   * Control plane only: validates a sender's token. A function
   * (`authkitTenantVerifier({ issuer, resource: 'urn:agora:telescope' })`,
   * `sharedSecretVerifier({ partitions })`), a class instance, or a lazy `() => import(...)`.
   */
  verifyTenant?: TenantVerifierInput;
  /** Control plane only: the ingest route's limits. */
  ingest?: IngestLimits;
  /** Tenant only: the server, the app name and the token. */
  tenant?: TelescopeTenantOptions;
}

/** The resolved topology the provider acts on. */
export type ResolvedTopology =
  | { topology: 'standalone' }
  | { topology: 'control-plane'; verifyTenant: TenantVerifierInput; ingest: ResolvedIngestLimits }
  | { topology: 'tenant'; tenant: TelescopeTenantOptions; buffer: ResolvedBufferOptions };

const PREFIX = '[@adonis-agora/telescope]';

/**
 * Validates the topology keys, so a misconfigured server or tenant fails at boot instead of on
 * the first request. Returns the resolved topology.
 */
export function resolveTopology(config: TelescopeTopologyConfig = {}): ResolvedTopology {
  const raw = config as TelescopeTopologyConfig & { verifyTenant?: unknown; tenant?: unknown };
  const topology = config.topology ?? 'standalone';
  if (topology !== 'standalone' && topology !== 'control-plane' && topology !== 'tenant') {
    throw new Error(`${PREFIX} topology must be 'standalone', 'control-plane' or 'tenant'`);
  }
  if (topology !== 'control-plane' && raw.verifyTenant !== undefined) {
    throw new Error(`${PREFIX} \`verifyTenant\` only applies to topology 'control-plane'`);
  }
  if (topology !== 'control-plane' && raw.ingest !== undefined) {
    throw new Error(`${PREFIX} \`ingest\` only applies to topology 'control-plane'`);
  }
  if (topology !== 'tenant' && raw.tenant !== undefined) {
    throw new Error(`${PREFIX} \`tenant\` only applies to topology 'tenant'`);
  }
  if (topology === 'control-plane') {
    const verify = raw.verifyTenant;
    if (verify === undefined || verify === null) {
      throw new Error(
        `${PREFIX} a control plane needs \`verifyTenant\` (authkitTenantVerifier({ issuer, resource: 'urn:agora:telescope' }) or sharedSecretVerifier({ partitions })): an app must never be trusted without a token`,
      );
    }
    const usable =
      typeof verify === 'function' ||
      (typeof verify === 'object' && typeof (verify as { verify?: unknown }).verify === 'function');
    if (!usable) {
      throw new Error(
        `${PREFIX} \`verifyTenant\` must be a function, an object with verify() (a class instance), or a lazy import of one`,
      );
    }
    return {
      topology,
      verifyTenant: verify as TenantVerifierInput,
      ingest: resolveIngestLimits(config.ingest),
    };
  }
  if (topology === 'tenant') {
    const tenant = config.tenant;
    if (!tenant || typeof tenant !== 'object') throw new Error(`${PREFIX} tenant is required`);
    if (typeof tenant.url !== 'string' || !/^https?:\/\//.test(tenant.url)) {
      throw new Error(`${PREFIX} tenant.url must be an absolute http(s) URL`);
    }
    if (typeof tenant.partition !== 'string' || tenant.partition === '') {
      throw new Error(`${PREFIX} tenant.partition is required`);
    }
    if (tenant.token === undefined || tenant.token === null || tenant.token === '') {
      throw new Error(
        `${PREFIX} tenant.token is required (authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:telescope' }) or the shared secret)`,
      );
    }
    if (tenant.local !== undefined && (typeof tenant.local !== 'string' || tenant.local === '')) {
      throw new Error(
        `${PREFIX} tenant.local must name a store (a key of \`stores\`, or 'memory')`,
      );
    }
    return { topology, tenant, buffer: resolveBufferOptions(tenant.buffer) };
  }
  return { topology: 'standalone' };
}

/** The server's route prefix from a tenant `url` (an origin gets the default path). */
export function serverPrefix(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path === '' ? DEFAULT_INGEST_PATH : path}`;
}

/** {@link IngestLimits} with defaults. */
export interface ResolvedIngestLimits {
  path: string;
  maxEntries: number;
  maxBodyBytes: number;
  maxEntryBytes: number;
  dedupeWindow: number;
}

const positive = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export function resolveIngestLimits(limits: IngestLimits = {}): ResolvedIngestLimits {
  const path = `/${(limits.path ?? DEFAULT_INGEST_PATH).replace(/^\/+|\/+$/g, '')}`;
  return {
    path,
    maxEntries: positive(limits.maxEntries, 1000),
    maxBodyBytes: positive(limits.maxBodyBytes, 2 * 1024 * 1024),
    maxEntryBytes: positive(limits.maxEntryBytes, 256 * 1024),
    dedupeWindow: positive(limits.dedupeWindow, 100_000),
  };
}

/** {@link TenantBufferOptions} with defaults. */
export interface ResolvedBufferOptions {
  maxEntries: number;
  batchSize: number;
  maxBatchBytes: number;
  flushIntervalMs: number;
  timeoutMs: number;
  retry: { baseMs: number; maxMs: number };
}

export function resolveBufferOptions(options: TenantBufferOptions = {}): ResolvedBufferOptions {
  return {
    maxEntries: positive(options.maxEntries, 10_000),
    batchSize: positive(options.batchSize, 200),
    maxBatchBytes: positive(options.maxBatchBytes, 512 * 1024),
    flushIntervalMs: positive(options.flushIntervalMs, 1000),
    timeoutMs: positive(options.timeoutMs, 10_000),
    retry: {
      baseMs: positive(options.retry?.baseMs, 1000),
      maxMs: positive(options.retry?.maxMs, 60_000),
    },
  };
}
