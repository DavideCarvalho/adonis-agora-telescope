import type { TelescopeStore } from '../store.js';
import {
  currentTenantLevels,
  type ResolvedTelescopeTenancy,
  type TenancySlotLike,
  tenancyOn,
  tenancySlot,
  tenantLabels,
  tenantOfTag,
  tenantTag,
} from '../tenancy.js';
import type { GuardResult } from './guard.js';

/**
 * Which tenants a console viewer may see, from its `authorize` decision:
 * - `{ all: true }`: `tenants: '*'` (every tenant, plus entries recorded with none);
 * - `{ all: false, ids }`: `tenants: [...]`, or the viewer's own active tenant when `authorize` named
 *   none (`ids` is empty when the viewer has no tenant: the console then shows nothing).
 * `null` when tenancy is off: no scoping at all.
 */
export type ConsoleTenantScope = { all: true } | { all: false; ids: string[]; own?: string };

export function consoleTenantScope(
  decision: Pick<GuardResult, 'tenants'>,
  tenancy: ResolvedTelescopeTenancy,
  slot: TenancySlotLike | undefined = tenancySlot(),
): ConsoleTenantScope | null {
  if (!tenancyOn(tenancy, slot)) return null;
  if (decision.tenants === '*') return { all: true };
  if (Array.isArray(decision.tenants)) return { all: false, ids: [...new Set(decision.tenants)] };
  // The viewer's own tenant: the level telescope scopes by (the most specific allowed kind).
  const levels = currentTenantLevels(tenancy, slot);
  const own = levels[levels.length - 1]?.id;
  return own === undefined ? { all: false, ids: [] } : { all: false, ids: [own], own };
}

/** What the request reads: the tenant tags to narrow by, or `null` for everything. */
export interface SelectedTenantScope {
  /** `null`: no narrowing (tenancy off, or `'*'` with "All organizations"). */
  tags: string[] | null;
  /** Whether the viewer is limited to some tenants (global actions are refused). */
  restricted: boolean;
  /** The `?tenant=` asked for an organization outside the viewer's scope. */
  forged: boolean;
}

/**
 * Intersect the viewer's scope with the organization the console asked for (`?tenant=<id>`, `*` or
 * absent = every organization in scope). An id outside the scope reads nothing (`forged: true`, the
 * caller audits it) — never a 403, so ids do not leak.
 */
export function selectTenantScope(
  scope: ConsoleTenantScope | null,
  requested: unknown,
  tenancy: ResolvedTelescopeTenancy,
): SelectedTenantScope {
  if (scope === null) return { tags: null, restricted: false, forged: false };
  const asked =
    typeof requested === 'string' && requested !== '' && requested !== '*' ? requested : undefined;
  if (scope.all) {
    return asked === undefined
      ? { tags: null, restricted: false, forged: false }
      : { tags: [tenantTag(tenancy, asked)], restricted: false, forged: false };
  }
  if (asked === undefined) {
    return { tags: scope.ids.map((id) => tenantTag(tenancy, id)), restricted: true, forged: false };
  }
  if (scope.ids.includes(asked)) {
    return { tags: [tenantTag(tenancy, asked)], restricted: true, forged: false };
  }
  return { tags: [], restricted: true, forged: true };
}

/** One organization in the console's picker. */
export interface TenantOption {
  id: string;
  label: string;
}

/** What `GET <path>/api/tenants` answers. */
export interface TenantScopeDescription {
  /** Tenancy is on: the console shows the picker. */
  enabled: boolean;
  /** The tag prefix entries carry (`'tenant'` → `tenant:<id>`). */
  tag: string;
  /** The viewer may see every organization ("All organizations" is offered). */
  all: boolean;
  /** The viewer's own organization, when it has one. */
  own?: TenantOption;
  /** The organizations the viewer may pick (for `all`: the ones telescope has entries for). */
  tenants: TenantOption[];
}

/**
 * Describe the viewer's scope for the picker. Labels: the viewer's own organization by its slug,
 * the others through `config/context.ts`'s `tenancy.label` resolver, else the id.
 */
export async function describeTenantScope(
  scope: ConsoleTenantScope | null,
  tenancy: ResolvedTelescopeTenancy,
  store: TelescopeStore,
  slot: TenancySlotLike | undefined = tenancySlot(),
): Promise<TenantScopeDescription> {
  if (scope === null) return { enabled: false, tag: tenancy.tag, all: true, tenants: [] };
  const ownLevel = currentTenantLevels(tenancy, slot).at(-1);
  let ids: string[];
  if (scope.all) {
    ids = await knownTenants(store, tenancy);
  } else {
    ids = scope.ids;
  }
  const labels = await tenantLabels(ids, slot);
  const label = (id: string) =>
    id === ownLevel?.id && ownLevel.slug !== undefined ? ownLevel.slug : (labels[id] ?? id);
  const description: TenantScopeDescription = {
    enabled: true,
    tag: tenancy.tag,
    all: scope.all,
    tenants: ids.map((id) => ({ id, label: label(id) })),
  };
  if (ownLevel !== undefined) description.own = { id: ownLevel.id, label: label(ownLevel.id) };
  return description;
}

/** The organizations telescope has entries for (most common first, at most 200). */
async function knownTenants(
  store: TelescopeStore,
  tenancy: ResolvedTelescopeTenancy,
): Promise<string[]> {
  const prefix = `${tenancy.tag}:`;
  const ids: string[] = [];
  const add = (tag: string) => {
    const id = tenantOfTag(tenancy, tag);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  };
  if (typeof store.countTags === 'function') {
    for (const row of await store.countTags({ limit: 200, prefix })) add(row.key);
    return ids;
  }
  for (const entry of await store.list({ size: 1000, omitContent: true })) {
    for (const tag of entry.tags) if (tag.startsWith(prefix)) add(tag);
    if (ids.length >= 200) break;
  }
  return ids;
}
