import type { ResolvedTelescopeConfig } from '../define_config.js';
import type { TelescopeStore } from '../store.js';
import { TenantScopedStore } from '../tenancy_store.js';
import type { GuardResult } from '../ui/guard.js';
import { consoleTenantScope, selectTenantScope } from '../ui/tenant_scope.js';
import { buildTelescopeMcpServer } from './build_server.js';
import type { McpToolName } from './define_config.js';
import type { TelescopeMcpServer } from './server.js';

/**
 * The MCP server for one caller: over the whole store, or (with tenancy on) over the organizations
 * its `authorize` granted (`tenants`, or the caller's own active tenant). Servers are cached per
 * scope.
 */
export function scopedMcpServers(
  store: TelescopeStore,
  coreConfig: ResolvedTelescopeConfig,
  tools?: ReadonlySet<McpToolName>,
): (decision: Pick<GuardResult, 'tenants'>) => TelescopeMcpServer {
  const shared = buildTelescopeMcpServer(store, coreConfig, tools);
  const cache = new Map<string, TelescopeMcpServer>();
  return (decision) => {
    const scope = consoleTenantScope(decision, coreConfig.tenancy);
    const { tags } = selectTenantScope(scope, undefined, coreConfig.tenancy);
    if (tags === null) return shared;
    const key = [...tags].sort().join('\n');
    let server = cache.get(key);
    if (server === undefined) {
      server = buildTelescopeMcpServer(new TenantScopedStore(store, tags), coreConfig, tools);
      if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
      cache.set(key, server);
    }
    return server;
  };
}
