import { httpTransport } from './transports/http.js';
import { isTelescopeTransport } from './transports/index.js';
import type { TelescopeTransport } from './transports/types.js';
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
   * or the full prefix (`https://telescope.example.com/_telescope/v1`). The same as
   * `transport: transports.http({ url })`; leave it out when `transport` is set.
   */
  url?: string;
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
  /**
   * This app sends entries on behalf of other apps: an entry its code tags `app:<name>` is stored
   * as `<name>`'s on the server (the token needs `telescope:ingest:relay`), and its own entries are
   * tagged `app:<partition>`, so the local console's App picker lists both. Default `false`.
   */
  relay?: boolean;
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
  /**
   * Tenant and control plane: how a tenant's entries reach the control plane, the same driver on
   * both sides (`transports.http/queue/bullmq/redis/durable`). Default HTTP. Browser traffic (the
   * console, live tail, client errors) is HTTP whatever is chosen, and a control plane keeps its
   * HTTP ingest route, so tenants on HTTP and on a broker can share it.
   */
  transport?: TelescopeTransport;
}

/** The resolved topology the provider acts on. */
export type ResolvedTopology =
  | { topology: 'standalone' }
  | {
      topology: 'control-plane';
      verifyTenant: TenantVerifierInput;
      ingest: ResolvedIngestLimits;
      /** The broker the control plane also consumes, or `null` (HTTP only). */
      transport: TelescopeTransport | null;
    }
  | {
      topology: 'tenant';
      tenant: TelescopeTenantOptions;
      buffer: ResolvedBufferOptions;
      /** How entries are sent (`transports.http({ url: tenant.url })` when only `url` is set). */
      transport: TelescopeTransport;
    };

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
  const rawTransport = (config as { transport?: unknown }).transport;
  if (topology === 'standalone' && rawTransport !== undefined) {
    throw new Error(`${PREFIX} \`transport\` only applies to topology 'tenant' or 'control-plane'`);
  }
  if (rawTransport !== undefined && !isTelescopeTransport(rawTransport)) {
    throw new Error(
      `${PREFIX} \`transport\` must be built with transports.http/queue/bullmq/redis/durable()`,
    );
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
      transport:
        config.transport !== undefined && config.transport.driver !== 'http'
          ? config.transport
          : null,
    };
  }
  if (topology === 'tenant') {
    const tenant = config.tenant;
    if (!tenant || typeof tenant !== 'object') throw new Error(`${PREFIX} tenant is required`);
    if (config.transport !== undefined && tenant.url !== undefined) {
      throw new Error(
        `${PREFIX} set the server in one place: tenant.url is transports.http({ url }); with \`transport\`, drop tenant.url`,
      );
    }
    if (
      config.transport === undefined &&
      (typeof tenant.url !== 'string' || !/^https?:\/\//.test(tenant.url) || !validUrl(tenant.url))
    ) {
      throw new Error(`${PREFIX} tenant.url must be an absolute http(s) URL`);
    }
    if (typeof tenant.partition !== 'string' || tenant.partition === '') {
      throw new Error(`${PREFIX} tenant.partition is required`);
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tenant.partition)) {
      throw new Error(`${PREFIX} tenant.partition must be 1-64 of A-Z a-z 0-9 _ . -`);
    }
    if (tenant.token === undefined || tenant.token === null || tenant.token === '') {
      throw new Error(
        `${PREFIX} tenant.token is required (authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:telescope' }) or the shared secret)`,
      );
    }
    if (tenant.relay !== undefined && typeof tenant.relay !== 'boolean') {
      throw new Error(`${PREFIX} tenant.relay must be a boolean`);
    }
    if (tenant.local !== undefined && (typeof tenant.local !== 'string' || tenant.local === '')) {
      throw new Error(
        `${PREFIX} tenant.local must name a store (a key of \`stores\`, or 'memory')`,
      );
    }
    return {
      topology,
      tenant,
      buffer: resolveBufferOptions(tenant.buffer),
      transport: config.transport ?? httpTransport({ url: tenant.url as string }),
    };
  }
  return { topology: 'standalone' };
}

function validUrl(url: string): boolean {
  try {
    serverPrefix(url);
    return true;
  } catch {
    return false;
  }
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
