import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { isTelescopeWork, runAsTelescopeWork } from '../self_scope.js';
import type { ServiceDirectory } from './directory.js';

/**
 * `fetch('http://billing/invoices/1')` → `https://billing.internal/invoices/1`.
 *
 * Only single-label hosts are touched (no dot, not an IP, not `localhost` or a `passthrough`
 * host); a host with a dot always goes out as written. A single-label host that names no app
 * fails the call with "app billing is not registered" rather than leaking to whatever DNS answers
 * for it.
 *
 * The rewrite runs in a dispatcher composed onto the global one, outermost, so every interceptor
 * after it (telescope's trace headers, the authkit client's token, the crypto envelope) sees the
 * real origin.
 */

/** Why a call to an app name failed. */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly app: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** What the rewrite needs besides the directory. */
export interface RewriteOptions {
  passthrough: Set<string>;
  failFast: boolean;
}

/** Where a call to `origin` goes instead: the new origin and a base path to prefix. */
export interface RewriteTarget {
  origin: string;
  basePath: string;
  app: string;
}

/** Whether `hostname` is an app name candidate: one DNS label, not an IP, not passed through. */
export function isAppHost(hostname: string, passthrough: Set<string>): boolean {
  const host = hostname.toLowerCase();
  if (host === '' || host.includes('.') || host.includes(':') || host.startsWith('[')) return false;
  if (/^\d+$/.test(host)) return false;
  return !passthrough.has(host);
}

/**
 * Where a call to `url` (an origin or a full URL) goes: `null` to leave it alone, a target to
 * rewrite it. Throws {@link DiscoveryError} for an app name nothing resolves.
 */
export function rewriteTarget(
  directory: ServiceDirectory,
  options: RewriteOptions,
  url: string | URL,
): RewriteTarget | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!isAppHost(parsed.hostname, options.passthrough)) return null;
  const app = parsed.hostname.toLowerCase();
  const found = directory.lookup(app);
  if (found.kind === 'unknown') {
    throw new DiscoveryError(
      `[@adonis-agora/telescope] app ${app} is not registered: no app named "${app}" in discovery (config/telescope.ts) or on the central server. Add it to discovery, or to discovery.passthrough if "${app}" is a host, not an app.`,
      app,
    );
  }
  if (found.kind === 'down' && options.failFast) {
    throw new DiscoveryError(
      `[@adonis-agora/telescope] app ${app} has no live instance (discovery.failFast is on)`,
      app,
    );
  }
  const target = new URL(found.url);
  return { origin: target.origin, basePath: target.pathname.replace(/\/+$/, ''), app };
}

/** The slice of undici's dispatch options the interceptor rewrites. */
interface DispatchOptions {
  origin?: string | URL;
  path?: string;
  [key: string]: unknown;
}

type Dispatch = (options: DispatchOptions, handler: unknown) => unknown;

/** The undici interceptor (`dispatcher.compose(...)`): rewrites the origin of app-name calls. */
export function discoveryInterceptor(directory: ServiceDirectory, options: RewriteOptions) {
  return (dispatch: Dispatch): Dispatch =>
    function discoveryDispatch(opts, handler) {
      if (opts.origin === undefined || isTelescopeWork()) return dispatch(opts, handler);
      const target = rewriteTarget(directory, options, String(opts.origin));
      if (target === null) return dispatch(opts, handler);
      return dispatch(
        { ...opts, origin: target.origin, path: `${target.basePath}${opts.path ?? '/'}` },
        handler,
      );
    };
}

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const slot = globalThis as Record<symbol, unknown>;

interface ComposableDispatcher {
  compose(...interceptors: unknown[]): unknown;
}

function isComposable(value: unknown): value is ComposableDispatcher {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { compose?: unknown }).compose === 'function'
  );
}

/**
 * Node creates its global dispatcher on the first `fetch`. One local call that fails at once
 * (nothing listens on port 9 of the loopback) makes it exist, so telescope can compose onto it
 * without depending on the `undici` package.
 */
async function ensureGlobalDispatcher(): Promise<void> {
  if (slot[GLOBAL_DISPATCHER] !== undefined) return;
  await runAsTelescopeWork(async () => {
    try {
      await fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(1000) });
    } catch {
      // Expected: the point was the dispatcher, not the answer.
    }
  });
}

/** The installed rewrite: re-asserts itself outermost, and uninstalls. */
export interface InstalledRewrite {
  /** Compose again on top if something replaced the global dispatcher since. */
  reassert(): void;
  uninstall(): void;
}

/** Compose the rewrite onto Node's global dispatcher, outermost. */
export async function installFetchRewrite(
  directory: ServiceDirectory,
  options: RewriteOptions,
): Promise<InstalledRewrite | null> {
  await ensureGlobalDispatcher();
  const original = slot[GLOBAL_DISPATCHER];
  if (!isComposable(original)) return null;
  const interceptor = discoveryInterceptor(directory, options);
  let ours = original.compose(interceptor);
  slot[GLOBAL_DISPATCHER] = ours;
  return {
    reassert() {
      const current = slot[GLOBAL_DISPATCHER];
      if (current === ours || !isComposable(current)) return;
      // Someone composed on top of us (or replaced the dispatcher): go back on top. A second
      // rewrite further in is a no-op, the origin is no longer an app name.
      ours = current.compose(interceptor);
      slot[GLOBAL_DISPATCHER] = ours;
    },
    uninstall() {
      if (slot[GLOBAL_DISPATCHER] === ours) slot[GLOBAL_DISPATCHER] = original;
    },
  };
}

type RequestFn = typeof http.request;

/** The URL a `http.request(...)` call targets, from its loose arguments. */
function requestUrl(protocol: string, args: unknown[]): { url: URL; rest: unknown[] } | null {
  const [first, ...rest] = args;
  if (typeof first === 'string' || first instanceof URL) {
    try {
      return { url: new URL(String(first)), rest };
    } catch {
      return null;
    }
  }
  if (first !== null && typeof first === 'object') {
    const o = first as {
      protocol?: string;
      hostname?: string;
      host?: string;
      port?: number | string;
      path?: string;
    };
    const host = o.hostname ?? o.host?.replace(/:\d+$/, '');
    if (typeof host !== 'string') return null;
    try {
      const url = new URL(`${o.protocol ?? protocol}//${host}`);
      if (o.port !== undefined) url.port = String(o.port);
      return { url, rest: [first, ...rest] };
    } catch {
      return null;
    }
  }
  return null;
}

/** Patch `http.request/get` and `https.request/get` to resolve app names. Returns the unpatch. */
export function installNodeHttpRewrite(
  directory: ServiceDirectory,
  options: RewriteOptions,
): () => void {
  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  const wrap = (protocol: 'http:' | 'https:', get: boolean): RequestFn =>
    function discoveryRequest(this: unknown, ...args: unknown[]) {
      const call = (proto: 'http:' | 'https:', callArgs: unknown[]) => {
        const fn =
          proto === 'https:'
            ? get
              ? originals.httpsGet
              : originals.httpsRequest
            : get
              ? originals.httpGet
              : originals.httpRequest;
        return (fn as (...a: unknown[]) => unknown)(...callArgs);
      };
      if (isTelescopeWork()) return call(protocol, args);
      const parsed = requestUrl(protocol, args);
      const target = parsed === null ? null : rewriteTarget(directory, options, parsed.url);
      if (parsed === null || target === null) return call(protocol, args);
      const to = new URL(target.origin);
      const proto = to.protocol as 'http:' | 'https:';
      const [first, ...rest] = args;
      let requestOptions: Record<string, unknown>;
      let tail: unknown[];
      if (typeof first === 'string' || first instanceof URL) {
        const url = parsed.url;
        // `request(url, [options], [callback])`.
        const hasOptions = rest[0] !== null && typeof rest[0] === 'object';
        const extra = hasOptions ? (rest[0] as Record<string, unknown>) : {};
        tail = hasOptions ? rest.slice(1) : rest;
        requestOptions = { ...extra, path: `${url.pathname}${url.search}` };
      } else {
        requestOptions = { ...(first as Record<string, unknown>) };
        tail = rest;
      }
      const path = typeof requestOptions.path === 'string' ? requestOptions.path : '/';
      const next: Record<string, unknown> = {
        ...requestOptions,
        protocol: proto,
        hostname: to.hostname,
        port: to.port === '' ? undefined : Number(to.port),
        path: `${target.basePath}${path}`,
      };
      delete next.host;
      // An agent belongs to one protocol: drop it when the call switches.
      if (proto !== protocol) delete next.agent;
      return call(proto, [next, ...tail]);
    } as unknown as RequestFn;

  http.request = wrap('http:', false);
  http.get = wrap('http:', true) as typeof http.get;
  https.request = wrap('https:', false);
  https.get = wrap('https:', true) as typeof https.get;
  syncBuiltinESMExports();
  return () => {
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    syncBuiltinESMExports();
  };
}
