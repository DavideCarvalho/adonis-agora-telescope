import type { ApplicationService } from '@adonisjs/core/types';
import { type TelescopeConfig, resolveConfig } from '../src/define_config.js';
import { DiagnosticsWatcher } from '../src/diagnostics_watcher.js';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../src/registry.js';
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
    const store: TelescopeStore = new InMemoryTelescopeStore({ maxEntries: config.maxEntries });
    this.store = store;

    // Bound by concrete class so consumers `inject()` them. The abstract
    // `TelescopeStore` contract is resolved via `InMemoryTelescopeStore` here;
    // a persistent store would register itself under the same class key.
    this.app.container.singleton(InMemoryTelescopeStore, () => store as InMemoryTelescopeStore);
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
  }

  async shutdown() {
    this.diagnosticsWatcher?.stop();
    this.diagnosticsWatcher = null;
    resetTelescopeRuntime();
  }
}
