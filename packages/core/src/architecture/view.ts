/**
 * The Architecture page: the apps and what links them, from whatever this telescope can see.
 *
 * - **Apps** come from the fleet (instances, health), from the calls, and from the grants.
 * - **Calls** are the outbound HTTP calls recorded in a recent window, grouped by the app that made
 *   them (`app:<id>`, or this app for untagged entries) and the app they went to (`to:<id>`, set
 *   when service discovery knew the origin; else the `host:` resolved now through discovery or the
 *   fleet's instance URLs). Read like the Pulse cards: one bounded list, `truncated` past the cap.
 * - **Grants** and **catalogs** come from authkit-server, when it runs in this process: who may call
 *   whom with which capabilities, and what each app accepts. Read from its global slot, so telescope
 *   never imports authkit.
 *
 * Each layer is absent (`sources.x === false`) when its data is not there.
 */
import { DISCOVERY_SLOT } from '../discovery/directory.js';
import { type Entry, EntryType } from '../entry.js';
import type { FleetView } from '../fleet/view.js';
import type { TelescopeStore } from '../store.js';

/** The slot authkit-server publishes its app-graph reader on. */
export const AUTHKIT_APP_GRAPH_SLOT = Symbol.for('@adonis-agora/authkit:app-graph');

/** The id of this app when its own entries carry no `app:` tag (a standalone telescope). */
export const SELF_APP = 'self';

export type ArchitectureHealth = 'ok' | 'warn' | 'down' | 'unknown';

export interface ArchitectureApp {
  id: string;
  /** Live instances (`up`, `starting`, `draining`), from the fleet; `null` when it has none. */
  instances: number | null;
  /** Worst check status on its live instances; `unknown` without fleet data. */
  health: ArchitectureHealth;
  /** Roles running (`web`, `durable:work`…), from the fleet. */
  roles: string[];
  /** A service-tenant client in authkit (it may call or be called with a token). */
  hasClient: boolean;
  /** What it accepts from the other apps, as it published it (`null`: never published). */
  accepts: string[] | null;
}

export interface ArchitectureCall {
  from: string;
  to: string;
  count: number;
  /** 5xx and network failures. */
  failed: number;
  avgMs: number;
  p95Ms: number;
  /** Epoch ms of the newest call in the window. */
  lastAt: number;
}

export interface ArchitectureGrant {
  from: string;
  to: string;
  capabilities: string[];
  /** The caller's client is disabled: it gets no token. */
  disabled: boolean;
}

export interface ArchitectureView {
  now: number;
  windowMs: number;
  apps: ArchitectureApp[];
  calls: ArchitectureCall[];
  grants: ArchitectureGrant[];
  sources: { fleet: boolean; calls: boolean; grants: boolean };
  /** The calls window hit the scan cap: counts are a lower bound. */
  truncated: boolean;
}

/** What the app-graph slot answers (authkit-server's `AppGraphSnapshot`, read structurally). */
interface AppGraphSnapshotLike {
  apps: Array<{ app: string; disabled: boolean; calls: Record<string, string[]> }>;
  catalogs: Array<{ app: string; capabilities: string[] }>;
}

function appGraphReader(): { snapshot(): Promise<AppGraphSnapshotLike> } | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[AUTHKIT_APP_GRAPH_SLOT];
  return slot != null &&
    typeof slot === 'object' &&
    typeof (slot as { snapshot?: unknown }).snapshot === 'function'
    ? (slot as { snapshot(): Promise<AppGraphSnapshotLike> })
    : undefined;
}

function discoveryAppOf(origin: string): string | undefined {
  const discovery = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as
    | { appOf?: (origin: string) => string | undefined }
    | undefined;
  if (typeof discovery?.appOf !== 'function') return undefined;
  try {
    return discovery.appOf(origin) || undefined;
  } catch {
    return undefined;
  }
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  for (const tag of tags) if (tag.startsWith(prefix)) return tag.slice(prefix.length);
  return undefined;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** host → app from the fleet's instance URLs, then discovery (both schemes) for the rest. */
function hostResolver(fleet: FleetView | null): (host: string) => string | undefined {
  const byHost = new Map<string, string>();
  for (const app of fleet?.apps ?? []) {
    for (const instance of app.instances) {
      const host = instance.url ? hostOf(instance.url) : null;
      if (host && !byHost.has(host)) byHost.set(host, app.app);
    }
  }
  const memo = new Map<string, string | undefined>();
  return (host) => {
    const key = host.toLowerCase();
    if (byHost.has(key)) return byHost.get(key);
    if (memo.has(key)) return memo.get(key);
    const found = discoveryAppOf(`https://${key}`) ?? discoveryAppOf(`http://${key}`);
    memo.set(key, found);
    return found;
  };
}

const RANK: Record<ArchitectureHealth, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** Group the window's outbound calls by (from, to). Calls to hosts that are not apps are left out. */
export function aggregateCalls(
  entries: readonly Entry[],
  resolveHost: (host: string) => string | undefined,
): ArchitectureCall[] {
  const groups = new Map<
    string,
    { from: string; to: string; durations: number[]; failed: number; lastAt: number }
  >();
  for (const entry of entries) {
    const tags = entry.tags ?? [];
    const from = tagValue(tags, 'app:') ?? SELF_APP;
    const host = tagValue(tags, 'host:');
    const to = tagValue(tags, 'to:') ?? (host ? resolveHost(host) : undefined);
    if (!to || to === from) continue;
    const key = `${from}\u0000${to}`;
    let group = groups.get(key);
    if (!group) {
      group = { from, to, durations: [], failed: 0, lastAt: 0 };
      groups.set(key, group);
    }
    group.durations.push(Math.max(0, entry.durationMs ?? 0));
    if (tags.includes('failed')) group.failed += 1;
    const at = new Date(entry.createdAt).getTime();
    if (at > group.lastAt) group.lastAt = at;
  }
  return [...groups.values()]
    .map((g) => {
      const sorted = [...g.durations].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, d) => acc + d, 0);
      return {
        from: g.from,
        to: g.to,
        count: sorted.length,
        failed: g.failed,
        avgMs: Math.round(sum / Math.max(1, sorted.length)),
        p95Ms: Math.round(percentile(sorted, 95)),
        lastAt: g.lastAt,
      };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export interface ReadArchitectureOptions {
  /** The viewer's slice of the store, or `null` to skip the calls. */
  store: TelescopeStore | null;
  /** The fleet as the viewer sees it, or `null` without one. */
  fleet: FleetView | null;
  /** How far back the calls are read. Default 1 h. */
  windowMs?: number;
  /** At most this many calls are read. Default 20,000. */
  scanCap?: number;
  /** The apps the viewer may see (`null`: all). */
  apps?: readonly string[] | null;
  now?: number;
}

export const DEFAULT_ARCHITECTURE_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_ARCHITECTURE_SCAN_CAP = 20_000;

/** The Architecture view. Never throws for a missing layer: it is reported in `sources`. */
export async function readArchitecture(
  options: ReadArchitectureOptions,
): Promise<ArchitectureView> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_ARCHITECTURE_WINDOW_MS;
  const scanCap = options.scanCap ?? DEFAULT_ARCHITECTURE_SCAN_CAP;
  const visible = options.apps ? new Set(options.apps) : null;
  const sees = (app: string) => visible === null || visible.has(app) || app === SELF_APP;

  const fleet = options.fleet && options.fleet.enabled ? options.fleet : null;

  let calls: ArchitectureCall[] = [];
  let truncated = false;
  if (options.store) {
    const entries = await options.store.list({
      type: EntryType.HttpClient,
      after: new Date(now - windowMs),
      before: new Date(now + 1),
      size: scanCap,
      omitContent: true,
    });
    truncated = entries.length >= scanCap;
    calls = aggregateCalls(entries, hostResolver(fleet)).filter((c) => sees(c.from) && sees(c.to));
  }

  let grants: ArchitectureGrant[] = [];
  let catalogs = new Map<string, string[]>();
  const clients = new Set<string>();
  const reader = appGraphReader();
  let grantsSource = false;
  if (reader) {
    try {
      const snapshot = await reader.snapshot();
      grantsSource = true;
      for (const app of snapshot.apps) {
        clients.add(app.app);
        for (const [to, capabilities] of Object.entries(app.calls ?? {})) {
          grants.push({
            from: app.app,
            to,
            capabilities: [...capabilities],
            disabled: app.disabled,
          });
        }
      }
      catalogs = new Map(snapshot.catalogs.map((c) => [c.app, [...c.capabilities]]));
    } catch {
      grantsSource = false;
    }
  }
  grants = grants
    .filter((g) => sees(g.from) && sees(g.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const ids = new Set<string>();
  for (const app of fleet?.apps ?? []) if (sees(app.app)) ids.add(app.app);
  for (const c of calls) {
    ids.add(c.from);
    ids.add(c.to);
  }
  for (const g of grants) {
    ids.add(g.from);
    ids.add(g.to);
  }
  for (const app of clients) if (sees(app)) ids.add(app);

  const fleetByApp = new Map((fleet?.apps ?? []).map((a) => [a.app, a]));
  const apps: ArchitectureApp[] = [...ids].sort().map((id) => {
    const inFleet = fleetByApp.get(id);
    let health: ArchitectureHealth = 'unknown';
    const roles: string[] = [];
    let instances: number | null = null;
    if (inFleet) {
      instances = inFleet.counts.up + inFleet.counts.starting + inFleet.counts.draining;
      roles.push(...inFleet.roles.map((r) => r.role));
      health = instances === 0 ? 'down' : 'ok';
      for (const instance of inFleet.instances) {
        if (instance.status === 'gone') continue;
        const h = instance.health as ArchitectureHealth;
        if (RANK[h] > RANK[health]) health = h;
      }
    }
    return {
      id,
      instances,
      health,
      roles,
      hasClient: clients.has(id),
      accepts: catalogs.get(id) ?? null,
    };
  });

  return {
    now,
    windowMs,
    apps,
    calls,
    grants,
    sources: { fleet: fleet !== null, calls: options.store !== null, grants: grantsSource },
    truncated,
  };
}
