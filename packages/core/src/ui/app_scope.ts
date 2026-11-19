import type { TelescopeStore } from '../store.js';
import type { ResolvedTelescopeTenancy } from '../tenancy.js';
import { scopedStore } from '../tenancy_store.js';
import type { GuardResult } from './guard.js';
import { consoleTenantScope, selectTenantScope } from './tenant_scope.js';

/** The tag prefix an entry recorded by app `x` carries on a server that collects several apps. */
export const APP_TAG = 'app';

/** `app:<id>`. */
export function appTag(id: string): string {
  return `${APP_TAG}:${id}`;
}

/** The app id of an `app:<id>` tag, or `undefined` for any other tag. */
export function appOfTag(tag: string): string | undefined {
  const prefix = `${APP_TAG}:`;
  return tag.startsWith(prefix) && tag.length > prefix.length
    ? tag.slice(prefix.length)
    : undefined;
}

/**
 * Which apps a console viewer may see, from its `authorize` decision:
 * - `{ all: true }`: `apps: '*'` or no `apps` at all (every app, plus entries recorded with none);
 * - `{ all: false, ids }`: `apps: [...]` (an empty list sees nothing).
 */
export type ConsoleAppScope = { all: true } | { all: false; ids: string[] };

export function consoleAppScope(decision: Pick<GuardResult, 'apps'>): ConsoleAppScope {
  if (Array.isArray(decision.apps)) return { all: false, ids: [...new Set(decision.apps)] };
  return { all: true };
}

/** What the request reads: the app tags to narrow by, or `null` for everything. */
export interface SelectedAppScope {
  /** `null`: no narrowing (every app, with "All apps"). */
  tags: string[] | null;
  /** Whether the viewer is limited to some apps (global actions are refused). */
  restricted: boolean;
  /** The `?app=` asked for an app outside the viewer's scope. */
  forged: boolean;
}

/**
 * Intersect the viewer's scope with the app the console asked for (`?app=<id>`; `*` or absent =
 * every app in scope). An id outside the scope reads nothing (`forged: true`, the caller logs it),
 * never a 403, so ids do not leak.
 */
export function selectAppScope(scope: ConsoleAppScope, requested: unknown): SelectedAppScope {
  const asked =
    typeof requested === 'string' && requested !== '' && requested !== '*' ? requested : undefined;
  if (scope.all) {
    return asked === undefined
      ? { tags: null, restricted: false, forged: false }
      : { tags: [appTag(asked)], restricted: false, forged: false };
  }
  if (asked === undefined) {
    return { tags: scope.ids.map(appTag), restricted: true, forged: false };
  }
  if (scope.ids.includes(asked)) return { tags: [appTag(asked)], restricted: true, forged: false };
  return { tags: [], restricted: true, forged: true };
}

/** Display names for app ids: a map, or a resolver given the ids to label. */
export type AppLabels =
  | Record<string, string>
  | ((ids: string[]) => Record<string, string> | Promise<Record<string, string>>);

/** One app in the console's picker. */
export interface AppOption {
  id: string;
  label: string;
  /**
   * How this console reaches it: `control-plane` (the app reports here), `federated` (read from
   * the app's own store). Absent for an app that tags this console's own entries otherwise.
   */
  mode?: 'control-plane' | 'federated';
  /** Who runs actions on its data: this console's server, the app itself, or nobody (read-only). */
  actions?: 'here' | 'app' | 'none';
}

/** What `GET <path>/api/apps` answers. */
export interface AppScopeDescription {
  /** Entries carry app tags (or the viewer is limited to some apps): the console shows the picker. */
  enabled: boolean;
  /** The tag prefix entries carry (`app:<id>`). */
  tag: string;
  /** The viewer may see every app ("All apps" is offered). */
  all: boolean;
  /** The apps the viewer may pick (for `all`: the ones telescope has entries for). */
  apps: AppOption[];
  /** This console's own entries (no `?app=`), named; present when federated apps are listed. */
  local?: { label: string };
  /** The picked app (`?app=`), or `null`; present when federated apps are listed. */
  selected?: string | null;
}

/** A federated app as the picker lists it. */
export interface FederatedAppOption {
  id: string;
  label: string;
  actions: 'app' | 'none';
}

/**
 * Add the federated apps the viewer may see to a picker description (after the apps tagging this
 * console's entries; a federated key wins over a tag of the same id). `controlPlane` marks the
 * tag-known apps as reporting here.
 */
export function withFederatedApps(
  description: AppScopeDescription,
  scope: ConsoleAppScope,
  federated: readonly FederatedAppOption[],
  options: { controlPlane: boolean; localLabel?: string; selected?: string | null },
): AppScopeDescription {
  const own = description.apps.map((app) =>
    options.controlPlane
      ? { ...app, mode: 'control-plane' as const, actions: 'here' as const }
      : app,
  );
  if (federated.length === 0) return { ...description, apps: own };
  const visible = federated.filter((app) => scope.all || scope.ids.includes(app.id));
  const keys = new Set(visible.map((app) => app.id));
  const apps: AppOption[] = [
    ...own.filter((app) => !keys.has(app.id)),
    ...visible.map((app) => ({
      id: app.id,
      label: app.label,
      mode: 'federated' as const,
      actions: app.actions,
    })),
  ];
  return {
    ...description,
    enabled: description.enabled || visible.length > 0,
    apps,
    local: {
      label: options.localLabel ?? (options.controlPlane ? 'All apps' : 'This app'),
    },
    selected: options.selected ?? null,
  };
}

/**
 * Describe the viewer's app scope for the picker; labels from `labels`, else the id. For a
 * viewer that sees every app, the apps come from `known` (default: {@link knownApps} over
 * `store`).
 */
export async function describeAppScope(
  scope: ConsoleAppScope,
  store: TelescopeStore,
  labels?: AppLabels,
  known: () => Promise<string[]> = () => knownApps(store),
): Promise<AppScopeDescription> {
  const ids = scope.all ? await known() : scope.ids;
  const names = await resolveLabels(ids, labels);
  return {
    enabled: !scope.all || ids.length > 0,
    tag: APP_TAG,
    all: scope.all,
    apps: ids.map((id) => ({ id, label: names[id] ?? id })),
  };
}

async function resolveLabels(ids: string[], labels: AppLabels | undefined) {
  if (labels === undefined || ids.length === 0) return {} as Record<string, string>;
  try {
    const resolved = typeof labels === 'function' ? await labels(ids) : labels;
    return resolved !== null && typeof resolved === 'object' ? resolved : {};
  } catch {
    return {};
  }
}

/** Most apps the picker lists. */
const MAX_APPS = 200;
/** How far back {@link knownApps} looks for app tags by default. */
const DEFAULT_APPS_WINDOW_MS = 3_600_000;
/** How many of the newest entries {@link knownApps} reads by default. */
const DEFAULT_APPS_SAMPLE = 1_000;

/** Where {@link knownApps} looks besides the entries. */
export interface KnownAppsOptions {
  /** Other lists of app ids (e.g. the fleet's instances); one that fails is skipped. */
  sources?: ReadonlyArray<() => Promise<readonly string[]>>;
  /** How far back to read entries. Default one hour. */
  windowMs?: number;
  /** How many of the newest entries in that window to read. Default 1000. */
  sampleSize?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * The apps the picker offers: those tagging the newest entries of the recent window (most
 * common first), then those only `sources` know, by name; at most 200. A bounded read, never a
 * scan of the table: an app quiet for longer than the window is found through a source (on a
 * control plane, the fleet's instances).
 */
export async function knownApps(
  store: TelescopeStore,
  options: KnownAppsOptions = {},
): Promise<string[]> {
  const now = options.now?.() ?? Date.now();
  const [entries, ...others] = await Promise.all([
    store.list({
      after: new Date(now - (options.windowMs ?? DEFAULT_APPS_WINDOW_MS)),
      size: options.sampleSize ?? DEFAULT_APPS_SAMPLE,
      omitContent: true,
    }),
    ...(options.sources ?? []).map((source) =>
      source().then(
        (ids) => [...ids],
        () => [] as string[],
      ),
    ),
  ]);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const id = appOfTag(tag);
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const ids = [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([id]) => id);
  const seen = new Set(ids);
  const rest = new Set<string>();
  for (const list of others) {
    for (const id of list) if (typeof id === 'string' && id !== '' && !seen.has(id)) rest.add(id);
  }
  return [...ids, ...[...rest].sort((a, b) => a.localeCompare(b))].slice(0, MAX_APPS);
}

/**
 * Remembers each scope's app list for `ttlMs` and shares one in-flight read between the
 * requests that arrive while it runs, so a console polling the picker costs one bounded read
 * per scope per TTL. A failed read is not remembered.
 */
export class KnownAppsCache {
  private readonly entries = new Map<string, { at: number; ids: Promise<string[]> }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly maxScopes = 1_000,
  ) {}

  get(key: string, load: () => Promise<string[]>): Promise<string[]> {
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached !== undefined && now - cached.at < this.ttlMs) return cached.ids;
    const ids = load();
    if (this.entries.size >= this.maxScopes) this.entries.clear();
    this.entries.set(key, { at: now, ids });
    ids.catch(() => {
      if (this.entries.get(key)?.ids === ids) this.entries.delete(key);
    });
    return ids;
  }
}

/**
 * The store a console viewer reads, from its `authorize` decision: the organizations it may see
 * (tenancy on) AND the apps it may see. `store` itself when the viewer sees everything.
 */
export function viewerStore(
  store: TelescopeStore,
  decision: Pick<GuardResult, 'tenants' | 'apps'>,
  tenancy: ResolvedTelescopeTenancy,
): TelescopeStore {
  const tenantTags = selectTenantScope(
    consoleTenantScope(decision, tenancy),
    undefined,
    tenancy,
  ).tags;
  const appTags = selectAppScope(consoleAppScope(decision), undefined).tags;
  return scopedStore(store, tenantTags, appTags);
}

/**
 * For a viewer narrowed to `appTags`: counts the entries of a trace that other apps recorded
 * (inside the viewer's organizations), for the waterfall's "N spans in other apps hidden" note.
 * Only the number leaves the store, never the entries.
 */
export function hiddenSpansCounter(
  store: TelescopeStore,
  tenantTags: readonly string[] | null,
  appTags: readonly string[],
): (traceId: string) => Promise<number> {
  const allowed = new Set(appTags);
  const source = scopedStore(store, tenantTags, null);
  return async (traceId) => {
    const entries = await source.list({ traceId, omitContent: true });
    return entries.filter((entry) => !entry.tags.some((tag) => allowed.has(tag))).length;
  };
}
