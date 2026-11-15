import { type ResolvedTopology, serverPrefix } from '../topology/config.js';
import { DiscoveryClient } from './client.js';
import type { ResolvedDiscoveryConfig } from './config.js';
import { publishDirectory, ServiceDirectory } from './directory.js';
import { installFetchRewrite, installNodeHttpRewrite } from './rewrite.js';

export {
  type DiscoveryConfig,
  type ResolvedDiscoveryConfig,
  resolveDiscovery,
} from './config.js';
export {
  DISCOVERY_SLOT,
  type DiscoveredApp,
  type DiscoveryContract,
  type DiscoveryMap,
  ServiceDirectory,
} from './directory.js';
export { DiscoveryError } from './rewrite.js';

/** Discovery running in this process. */
export interface RunningDiscovery {
  directory: ServiceDirectory;
  /** Put the rewrite back on top of the global dispatcher (call once the app is ready). */
  reassert(): void;
  stop(): Promise<void>;
}

/** The central server's prefix a tenant reads the map from, or `null`. */
function tenantPrefix(config: ResolvedDiscoveryConfig, topology: ResolvedTopology): string | null {
  if (topology.topology !== 'tenant') return null;
  if (config.serverUrl !== null) return serverPrefix(config.serverUrl);
  const transport = topology.transport as { driver: string; options?: { url?: unknown } };
  if (transport.driver === 'http' && typeof transport.options?.url === 'string') {
    return serverPrefix(transport.options.url);
  }
  return null;
}

/**
 * Start discovery: the static map, plus (a tenant) the central server's, published on the global
 * contract and used to rewrite `http://<app>/…` calls. `null` when there is nothing to resolve
 * (no static app and no central server to ask), so an app without discovery is left untouched.
 */
export async function startDiscovery(options: {
  config: ResolvedDiscoveryConfig;
  topology: ResolvedTopology;
  onError?: (message: string) => void;
}): Promise<RunningDiscovery | null> {
  const { config, topology } = options;
  if (!config.enabled) return null;
  const prefix = tenantPrefix(config, topology);
  if (Object.keys(config.apps).length === 0 && prefix === null) return null;

  const directory = new ServiceDirectory(config.apps);
  const client =
    prefix !== null && topology.topology === 'tenant'
      ? new DiscoveryClient({
          prefix,
          token: topology.tenant.token,
          partition: topology.tenant.partition,
          directory,
          snapshotPath: config.snapshotPath,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : null;
  client?.start();
  const unpublish = publishDirectory(directory);
  const rewriteOptions = { passthrough: config.passthrough, failFast: config.failFast };
  const fetchRewrite = await installFetchRewrite(directory, rewriteOptions);
  if (fetchRewrite === null) {
    options.onError?.(
      'the global fetch dispatcher cannot be composed: fetch calls are not resolved',
    );
  }
  const unpatchHttp = config.nodeHttp ? installNodeHttpRewrite(directory, rewriteOptions) : null;

  return {
    directory,
    reassert: () => fetchRewrite?.reassert(),
    async stop() {
      await client?.stop();
      fetchRewrite?.uninstall();
      unpatchHttp?.();
      unpublish();
    },
  };
}
