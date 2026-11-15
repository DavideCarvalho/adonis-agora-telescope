import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { durationToMs } from '../alerts/parse_duration.js';
import type { FleetStore } from './store.js';

/** `fleet` in `config/telescope.ts`: this instance's heartbeat, and how the fleet is read. */
export interface FleetConfig {
  /** Send heartbeats and keep the fleet. Default `true`. */
  enabled?: boolean;
  /** How often each instance sends a heartbeat. Default `'15s'`. */
  interval?: number | string;
  /**
   * This app's name in the fleet when it keeps its own entries (standalone, control plane). A
   * tenant is named by its token. Default `APP_NAME`, else the package.json `name`, else `'app'`.
   */
  app?: string;
  /**
   * The deployed version: a string, or a function. Default the first of `GIT_SHA`, `COMMIT_SHA`,
   * `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`,
   * `HEROKU_SLUG_COMMIT`, `K_REVISION` (a sha is cut to 12 characters), else the package.json `version`.
   */
  version?: string | (() => string | null | Promise<string | null>);
  /** Host or pod name. Default `HOSTNAME`, else the OS hostname. */
  host?: string;
  /** An instance is gone after this many missed heartbeats. Default 3. */
  goneAfter?: number;
  /** How long a gone instance is kept (its deploy and restart history). Default `'7d'`. */
  retention?: number | string;
  /** A restart loop: `restarts` boots on one host `within` a window. Default 3 in `'10m'`. */
  restartLoop?: { restarts?: number; within?: number | string };
  /**
   * Where the control plane (or a standalone app) keeps instances: `'auto'` (default: a table
   * next to a Lucid entries store, same connection and `schema`; in memory otherwise),
   * `'memory'`, or a {@link FleetStore}.
   */
  store?: 'auto' | 'memory' | FleetStore;
  /**
   * Which AdonisJS environments send a heartbeat. Default `['web']` (the HTTP server). Add
   * `'console'` for queue workers started with `node ace`; every other ace command then reports
   * too, briefly.
   */
  report?: Array<'web' | 'console' | 'repl' | 'test'>;
}

/** {@link FleetConfig} with defaults. */
export interface ResolvedFleetConfig {
  enabled: boolean;
  intervalMs: number;
  app: string | null;
  version: FleetConfig['version'] | null;
  host: string;
  goneAfterIntervals: number;
  retentionMs: number;
  restartLoop: { restarts: number; withinMs: number };
  store: 'auto' | 'memory' | FleetStore;
  report: string[];
}

const PREFIX = '[@adonis-agora/telescope]';

function positiveMs(value: number | string | undefined, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  let parsed: number;
  try {
    parsed = durationToMs(value);
  } catch {
    throw new Error(`${PREFIX} fleet.${key} must be a duration such as '15s' or '10m'`);
  }
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${PREFIX} fleet.${key} must be a positive duration`);
  }
  return parsed;
}

export function resolveFleetConfig(config: FleetConfig | false | undefined): ResolvedFleetConfig {
  const fleet = config === false ? { enabled: false } : (config ?? {});
  const store = fleet.store ?? 'auto';
  if (
    store !== 'auto' &&
    store !== 'memory' &&
    (typeof store !== 'object' || typeof (store as FleetStore).upsert !== 'function')
  ) {
    throw new Error(`${PREFIX} fleet.store must be 'auto', 'memory' or a FleetStore`);
  }
  if (fleet.app !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(fleet.app)) {
    throw new Error(`${PREFIX} fleet.app must be 1-64 of A-Z a-z 0-9 _ . -`);
  }
  const intervalMs = positiveMs(fleet.interval, 15_000, 'interval');
  if (intervalMs < 1000) throw new Error(`${PREFIX} fleet.interval must be at least 1s`);
  const goneAfter = fleet.goneAfter ?? 3;
  if (!Number.isInteger(goneAfter) || goneAfter < 1) {
    throw new Error(`${PREFIX} fleet.goneAfter must be a whole number of heartbeats (1 or more)`);
  }
  const restarts = fleet.restartLoop?.restarts ?? 3;
  if (!Number.isInteger(restarts) || restarts < 2) {
    throw new Error(`${PREFIX} fleet.restartLoop.restarts must be 2 or more`);
  }
  return {
    enabled: fleet.enabled ?? true,
    intervalMs,
    app: fleet.app ?? null,
    version: fleet.version ?? null,
    host: fleet.host ?? process.env.HOSTNAME ?? safeHostname(),
    goneAfterIntervals: goneAfter,
    retentionMs: positiveMs(fleet.retention, 7 * 86_400_000, 'retention'),
    restartLoop: {
      restarts,
      withinMs: positiveMs(fleet.restartLoop?.within, 10 * 60_000, 'restartLoop.within'),
    },
    store,
    report: [...(fleet.report ?? ['web'])],
  };
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

/** Environment variables hosts set to the deployed commit, checked in order. */
export const VERSION_ENV_VARS = [
  'GIT_SHA',
  'COMMIT_SHA',
  'SOURCE_VERSION',
  'RENDER_GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'HEROKU_SLUG_COMMIT',
  'K_REVISION',
] as const;

async function readPackageJson(
  appRoot: URL | string | undefined,
): Promise<Record<string, unknown>> {
  if (appRoot === undefined) return {};
  try {
    const url = new URL('package.json', appRoot.toString().endsWith('/') ? appRoot : `${appRoot}/`);
    return JSON.parse(await readFile(url, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The version an instance reports (see {@link FleetConfig.version}). */
export async function resolveVersion(
  configured: FleetConfig['version'] | null,
  appRoot?: URL | string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (typeof configured === 'string') return configured.slice(0, 100);
  if (typeof configured === 'function') {
    try {
      const value = await configured();
      return typeof value === 'string' && value !== '' ? value.slice(0, 100) : null;
    } catch {
      return null;
    }
  }
  for (const name of VERSION_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      const trimmed = value.trim();
      return /^[0-9a-f]{13,40}$/i.test(trimmed) ? trimmed.slice(0, 12) : trimmed.slice(0, 100);
    }
  }
  const version = (await readPackageJson(appRoot)).version;
  return typeof version === 'string' ? version : null;
}

/** The app name a standalone app or a control plane reports for itself. */
export async function resolveSelfApp(
  configured: string | null,
  appRoot?: URL | string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (configured !== null) return configured;
  const fromEnv = env.APP_NAME;
  const clean = (value: string) =>
    value
      .replace(/^@[^/]+\//, '')
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .slice(0, 64);
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return clean(fromEnv.trim()) || 'app';
  const name = (await readPackageJson(appRoot)).name;
  return typeof name === 'string' && name !== '' ? clean(name) || 'app' : 'app';
}
