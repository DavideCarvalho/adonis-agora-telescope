import type { ApplicationService } from '@adonisjs/core/types';
import {
  type ResolvedTelescopeConfig,
  type TelescopeConfig,
  resolveConfig,
} from '../src/define_config.js';
import { DiagnosticsWatcher } from '../src/diagnostics_watcher.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import type { ExtensionContext } from '../src/extension/types.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';
import {
  resetTelescopeRuntime,
  setTelescopeExtensionRegistry,
  setTelescopeRuntime,
} from '../src/registry.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';

/**
 * Wires `@agora/telescope` into the AdonisJS application.
 *
 * - `register()` binds the {@link TelescopeStore} and {@link TelescopeService}
 *   into the container so controllers can `inject()` them.
 * - `boot()` reads `config/telescope.ts`, publishes the store on the global
 *   runtime slot (so the request middleware can reach it without DI), and starts
 *   the {@link DiagnosticsWatcher} when the `diagnostics` watcher is enabled.
 * - `shutdown()` stops the watcher and clears the runtime slot.
 *
 * The request watcher itself runs as `server` middleware, which
 * `node ace configure @agora/telescope` registers on the `server` stack.
 */
export default class TelescopeProvider {
  private store: TelescopeStore | null = null;
  private diagnosticsWatcher: DiagnosticsWatcher | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    // Use the supplied store instance (e.g. `lucidTelescopeStore(db)`) when given,
    // otherwise fall back to the built-in in-memory ring buffer.
    const store: TelescopeStore =
      config.store === 'memory'
        ? new InMemoryTelescopeStore({ maxEntries: config.maxEntries })
        : config.store;
    this.store = store;

    // Bound by concrete class so consumers `inject()` them. The in-memory default
    // is also registered under `InMemoryTelescopeStore` for direct injection; the
    // `TelescopeService` always resolves against whichever store is active.
    if (store instanceof InMemoryTelescopeStore) {
      this.app.container.singleton(InMemoryTelescopeStore, () => store);
    }
    this.app.container.singleton(TelescopeService, () => new TelescopeService(store));
  }

  async boot() {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const store = this.store;
    if (!config.enabled || !store) {
      resetTelescopeRuntime();
      return;
    }

    setTelescopeRuntime(store, config.watchers.has('request'));

    if (config.watchers.has('diagnostics')) {
      const watcher = new DiagnosticsWatcher(store);
      watcher.start();
      this.diagnosticsWatcher = watcher;
    }

    // Build the extension registry from `config.extensions` and publish it so the UI can serve each
    // extension's dashboards + data providers. A collision (duplicate id/name) throws here, at boot.
    setTelescopeExtensionRegistry(this.buildExtensionRegistry(config, store));
  }

  /** Construct the extension registry, giving each extension a context over the store + container. */
  private buildExtensionRegistry(
    config: ResolvedTelescopeConfig,
    store: TelescopeStore,
  ): ExtensionRegistry | null {
    if (config.extensions.length === 0) return null;
    const ctx: ExtensionContext = {
      store,
      container: { make: (token) => this.app.container.make(token as never) },
      config,
    };
    return new ExtensionRegistry(config.extensions, ctx);
  }

  async shutdown() {
    this.diagnosticsWatcher?.stop();
    this.diagnosticsWatcher = null;
    resetTelescopeRuntime();
  }
}
