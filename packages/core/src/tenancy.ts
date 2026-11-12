/**
 * Tenancy for telescope, read STRUCTURALLY from `@adonis-agora/context`'s tenancy slot
 * (`Symbol.for('@agora/context:tenancy')`, version 1). Telescope never imports context; without it
 * (or with an older one) tenancy is simply off.
 *
 * Telescope stores operational data across tenants. With tenancy on it TAGS every entry with the
 * active tenant (`tenant:<id>`, one tag per level of a nested tenant, `tenant:*` inside
 * `Context.allTenants()`), and the console shows each viewer only the tenants its `authorize` grants.
 */

/** One level of a tenant (mirrors `@adonis-agora/context`'s `TenantLevel`). */
export interface TenantLevelLike {
  id: string;
  kind: string;
  slug?: string;
}

/** What `tenantFilter()` answers (mirrors `@adonis-agora/context`'s `TenantFilter`). */
export type TenantFilterLike =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantLevelLike; chain: TenantLevelLike[] };

/** The slice of the context tenancy slot telescope reads. */
export interface TenancySlotLike {
  readonly version: number;
  tenancy(): { enabled: boolean; kinds?: string[] };
  tenantFilter(options?: { kinds?: string[] }): TenantFilterLike;
  tenantLabels?(ids: string[], kind?: string): Promise<Record<string, string>>;
}

const TENANCY_SLOT = Symbol.for('@agora/context:tenancy');

/** The context tenancy slot, or `undefined` when `@adonis-agora/context` (with tenancy) is absent. */
export function tenancySlot(): TenancySlotLike | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[TENANCY_SLOT] as TenancySlotLike | undefined;
  if (slot === undefined || slot === null || slot.version !== 1) return undefined;
  if (typeof slot.tenancy !== 'function' || typeof slot.tenantFilter !== 'function') {
    return undefined;
  }
  return slot;
}

/** The `tenancy` option of `config/telescope.ts`. */
export type TelescopeTenancyConfig =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `tenancy.enabled` in `config/context.ts`. */
      enabled?: 'inherit' | boolean;
      /** Only tenants of these kinds (else `tenancy.kinds` from `config/context.ts`). */
      kinds?: string[];
      /** The tag prefix. Default `'tenant'` (tags read `tenant:<id>`). */
      tag?: string;
    };

/** {@link TelescopeTenancyConfig} with defaults applied. */
export interface ResolvedTelescopeTenancy {
  enabled: 'inherit' | boolean;
  kinds?: string[];
  tag: string;
}

export function resolveTenancy(
  config: TelescopeTenancyConfig | undefined,
): ResolvedTelescopeTenancy {
  if (config === false) return { enabled: false, tag: 'tenant' };
  if (config === undefined || config === 'inherit') return { enabled: 'inherit', tag: 'tenant' };
  const tag = typeof config.tag === 'string' && config.tag !== '' ? config.tag : 'tenant';
  return {
    enabled: config.enabled ?? 'inherit',
    tag,
    ...(config.kinds !== undefined ? { kinds: [...config.kinds] } : {}),
  };
}

/** Whether telescope scopes by tenant right now. */
export function tenancyOn(
  config: ResolvedTelescopeTenancy,
  slot: TenancySlotLike | undefined = tenancySlot(),
): boolean {
  if (config.enabled === false || slot === undefined) return false;
  if (config.enabled === true) return true;
  try {
    return slot.tenancy().enabled === true;
  } catch {
    return false;
  }
}

/** The tag of one tenant id. */
export function tenantTag(config: ResolvedTelescopeTenancy, id: string): string {
  return `${config.tag}:${id}`;
}

/** The tenant id a tag names, or `undefined` when it is not a tenant tag (or is the `*` marker). */
export function tenantOfTag(config: ResolvedTelescopeTenancy, tag: string): string | undefined {
  const prefix = `${config.tag}:`;
  if (!tag.startsWith(prefix)) return undefined;
  const id = tag.slice(prefix.length);
  return id === '' || id === '*' ? undefined : id;
}

/**
 * The tenant tags of the current context: one per level of the active tenant (outermost first),
 * `[<tag>:*]` inside `Context.allTenants()`, none without a tenant. Never throws.
 */
export function currentTenantTags(
  config: ResolvedTelescopeTenancy,
  slot: TenancySlotLike | undefined = tenancySlot(),
): string[] {
  if (!tenancyOn(config, slot) || slot === undefined) return [];
  try {
    const filter = slot.tenantFilter(config.kinds !== undefined ? { kinds: config.kinds } : {});
    if (filter.mode === 'all') return [`${config.tag}:*`];
    if (filter.mode !== 'tenant') return [];
    const chain = filter.chain.length > 0 ? filter.chain : [filter.tenant];
    return chain.map((level) => tenantTag(config, String(level.id)));
  } catch {
    return [];
  }
}

/** The active tenant levels of the current context (outermost first), for the console. */
export function currentTenantLevels(
  config: ResolvedTelescopeTenancy,
  slot: TenancySlotLike | undefined = tenancySlot(),
): TenantLevelLike[] {
  if (!tenancyOn(config, slot) || slot === undefined) return [];
  try {
    const filter = slot.tenantFilter(config.kinds !== undefined ? { kinds: config.kinds } : {});
    if (filter.mode !== 'tenant') return [];
    return filter.chain.length > 0 ? filter.chain : [filter.tenant];
  } catch {
    return [];
  }
}

/** Display labels for tenant ids from `config/context.ts`'s `tenancy.label`, or `{}`. */
export async function tenantLabels(
  ids: string[],
  slot: TenancySlotLike | undefined = tenancySlot(),
): Promise<Record<string, string>> {
  if (ids.length === 0 || slot?.tenantLabels === undefined) return {};
  try {
    const labels = await slot.tenantLabels(ids);
    return labels !== null && typeof labels === 'object' ? labels : {};
  } catch {
    return {};
  }
}
