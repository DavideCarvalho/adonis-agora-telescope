import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { selectedTenant } from '../client/telescope-client.js';
import type { TenantScope } from '../client/types.js';
import { useTenants } from './use-telescope.js';

/** The page URL showing `tenant` (`undefined` = every organization), the hash route kept. */
export function urlForTenant(tenant: string | undefined, href = window.location.href): string {
  const url = new URL(href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The label of a tenant id in this scope (its id when the scope does not know it). */
export function tenantLabel(scope: TenantScope | null, id: string): string {
  return (
    scope?.tenants.find((t) => t.id === id)?.label ?? (scope?.own?.id === id ? scope.own.label : id)
  );
}

const TEXT = {
  noun: 'Organization',
  all: 'All organizations',
  some: 'Every organization you can see',
  search: 'Search organizations',
  empty: 'No organizations.',
};

/**
 * The header's "Organization" control: a fixed chip when the viewer sees one organization, a
 * searchable picker when it sees several or all of them. Picking reloads the console with
 * `?tenant=<id>`; every request then reads that organization only.
 */
export function TenantPicker() {
  const { data } = useTenants();
  const current = selectedTenant();
  if (data === null || !data.enabled) return null;
  if (!data.all && data.tenants.length <= 1) {
    const only = data.tenants[0];
    return <ScopeChip noun={TEXT.noun} label={only ? only.label : 'none'} kind="tenant" />;
  }
  return (
    <ScopeMenu
      items={data.tenants}
      all={data.all}
      current={current}
      text={TEXT}
      labelOf={(id) => tenantLabel(data, id)}
      onChoose={(next) => window.location.assign(urlForTenant(next))}
    />
  );
}

/** Shown instead of data when tenancy is on and the viewer has no organization to look at. */
export function TenantEmptyNotice() {
  const { data } = useTenants();
  if (data === null || !data.enabled || data.all || data.tenants.length > 0) return null;
  return (
    <p
      className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-3 text-xs text-fg-2"
      role="status"
    >
      Choose an organization to see its data.
    </p>
  );
}
