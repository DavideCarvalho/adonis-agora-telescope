import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAppUrl } from '../fleet/config.js';

/**
 * `discovery` in `config/telescope.ts`: reach your apps by name, `fetch('http://billing/invoices/1')`.
 *
 * Each key that is not an option below names an app and gives its URL. Those apps resolve from this
 * map first, ahead of what the central server says (a standalone app, or local development):
 *
 * ```ts
 * discovery: {
 *   billing: 'http://localhost:3334',
 *   snapshotPath: 'tmp/discovery.json',
 * }
 * ```
 */
export interface DiscoveryConfig {
  /** Turn discovery off (`false`). Default on when there is something to resolve. */
  enabled?: boolean;
  /**
   * Where a tenant keeps the last map the central server sent, so calls keep resolving while the
   * server is down or the app restarts without it. Default `telescope-discovery-<app>.json` in the
   * OS temp directory. A snapshot written for another app or server is never read.
   */
  snapshotPath?: string;
  /**
   * Fail a call to an app the central server knows but has no live instance of, instead of
   * sending it to the last URL seen. Default `false`.
   */
  failFast?: boolean;
  /**
   * Fail a call to a single-label host that names no app (`http://billng/…`, a typo) with "app
   * billng is not registered", instead of letting it go out as written. Hosts in `passthrough` are
   * still let through. Default `false`: an unknown single-label host (a Docker Compose service such
   * as `http://minio:9000`) goes out untouched.
   */
  strict?: boolean;
  /** Also resolve names in `http.request` / `https.request` (axios, got). Default `false`. */
  nodeHttp?: boolean;
  /**
   * With `strict`: single-label hosts that are not apps and must go out untouched (`minio`,
   * `mailpit`). `localhost` always does.
   */
  passthrough?: string[];
  /**
   * A tenant whose `transport` is not HTTP: the central server's URL (its origin, or the ingest
   * prefix) to read the map from. A tenant on HTTP uses its transport's URL.
   */
  serverUrl?: string;
  /** An app name and its URL. */
  [app: string]: string | string[] | boolean | undefined;
}

/** The keys of {@link DiscoveryConfig} that are options, not app names. */
export const DISCOVERY_OPTIONS = new Set([
  'enabled',
  'snapshotPath',
  'failFast',
  'strict',
  'nodeHttp',
  'passthrough',
  'serverUrl',
]);

/** {@link DiscoveryConfig} with defaults. */
export interface ResolvedDiscoveryConfig {
  enabled: boolean;
  /** The static map: lowercase app name → base URL. */
  apps: Record<string, string>;
  /** `null`: the default, a file per app in the OS temp directory. */
  snapshotPath: string | null;
  failFast: boolean;
  strict: boolean;
  nodeHttp: boolean;
  passthrough: Set<string>;
  serverUrl: string | null;
}

const PREFIX = '[@adonis-agora/telescope]';
const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

/** The default snapshot file of app `partition`. */
export function defaultSnapshotPath(partition: string): string {
  return join(tmpdir(), `telescope-discovery-${partition.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/** Resolve `discovery`. Throws on a malformed app URL or name. */
export function resolveDiscovery(
  config: DiscoveryConfig | false | undefined,
): ResolvedDiscoveryConfig {
  const raw = config === false ? { enabled: false } : (config ?? {});
  const apps: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (DISCOVERY_OPTIONS.has(key)) continue;
    if (!NAME_RE.test(key)) {
      throw new Error(
        `${PREFIX} discovery.${key}: an app name is a single DNS label (A-Z a-z 0-9 _ -), so it can be a URL host`,
      );
    }
    const url = normalizeAppUrl(value);
    if (url === null) {
      throw new Error(`${PREFIX} discovery.${key} must be an absolute http(s) URL`);
    }
    apps[key.toLowerCase()] = url;
  }
  const serverUrl = raw.serverUrl === undefined ? null : normalizeAppUrl(raw.serverUrl);
  if (raw.serverUrl !== undefined && serverUrl === null) {
    throw new Error(`${PREFIX} discovery.serverUrl must be an absolute http(s) URL`);
  }
  const passthrough = raw.passthrough ?? [];
  if (!Array.isArray(passthrough) || !passthrough.every((h) => typeof h === 'string')) {
    throw new Error(`${PREFIX} discovery.passthrough must be a list of host names`);
  }
  return {
    enabled: raw.enabled !== false,
    apps,
    snapshotPath:
      typeof raw.snapshotPath === 'string' && raw.snapshotPath !== '' ? raw.snapshotPath : null,
    failFast: raw.failFast === true,
    strict: raw.strict === true,
    nodeHttp: raw.nodeHttp === true,
    passthrough: new Set(['localhost', ...passthrough.map((h) => h.toLowerCase())]),
    serverUrl,
  };
}
