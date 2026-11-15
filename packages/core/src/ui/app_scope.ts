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
}

/** Describe the viewer's app scope for the picker; labels from `labels`, else the id. */
export async function describeAppScope(
  scope: ConsoleAppScope,
  store: TelescopeStore,
  labels?: AppLabels,
): Promise<AppScopeDescription> {
  const ids = scope.all ? await knownApps(store) : scope.ids;
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

/** The apps telescope has entries for (most common first, at most 200). */
async function knownApps(store: TelescopeStore): Promise<string[]> {
  const ids: string[] = [];
  const add = (tag: string) => {
    const id = appOfTag(tag);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  };
  if (typeof store.countTags === 'function') {
    for (const row of await store.countTags({ limit: 200, prefix: `${APP_TAG}:` })) add(row.key);
    return ids;
  }
  for (const entry of await store.list({ size: 1000, omitContent: true })) {
    for (const tag of entry.tags) add(tag);
    if (ids.length >= 200) break;
  }
  return ids;
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
