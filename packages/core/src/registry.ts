import type { ExtensionRegistry } from './extension/registry.js';
import type { TelescopeStore } from './store.js';

/**
 * The live runtime telescope handles, published on a cross-copy-stable global slot
 * so the request middleware can reach the active store WITHOUT constructor wiring
 * — mirroring the "singleton lives outside the container" stance the Agora
 * ecosystem uses for context/diagnostics. The provider sets this at boot and
 * clears it at shutdown.
 */
export interface TelescopeRuntime {
  /** The active store, or `null` when telescope is disabled / not booted. */
  store: TelescopeStore | null;
  /** Whether the request watcher should record. */
  requestWatcherEnabled: boolean;
  /** The booted extension registry (entry types / dashboards / data providers), or `null`. */
  registry: ExtensionRegistry | null;
}

const RUNTIME_KEY = Symbol.for('@agora/telescope:runtime');
const globalStore = globalThis as typeof globalThis & { [RUNTIME_KEY]?: TelescopeRuntime };

const runtime: TelescopeRuntime = globalStore[RUNTIME_KEY] ?? {
  store: null,
  requestWatcherEnabled: false,
  registry: null,
};
globalStore[RUNTIME_KEY] = runtime;

/** The shared runtime handle. */
export function getTelescopeRuntime(): TelescopeRuntime {
  return runtime;
}

/** Install the active store + flags (called by the provider at boot). */
export function setTelescopeRuntime(store: TelescopeStore, requestWatcherEnabled: boolean): void {
  runtime.store = store;
  runtime.requestWatcherEnabled = requestWatcherEnabled;
}

/** Publish the booted extension registry so the UI can serve its dashboards + providers. */
export function setTelescopeExtensionRegistry(registry: ExtensionRegistry | null): void {
  runtime.registry = registry;
}

/** Tear down the runtime (called by the provider at shutdown). */
export function resetTelescopeRuntime(): void {
  runtime.store = null;
  runtime.requestWatcherEnabled = false;
  runtime.registry = null;
}
