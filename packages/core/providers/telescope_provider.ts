import type { ApplicationService } from '@adonisjs/core/types';
import {
  type ResolvedTelescopeConfig,
  type TelescopeConfig,
  resolveConfig,
} from '../src/define_config.js';
import { DiagnosticsWatcher } from '../src/diagnostics_watcher.js';
import { ExtensionRegistry } from '../src/extension/registry.js';
import type { ExtensionContext } from '../src/extension/types.js';
import {
  resetTelescopeRuntime,
  setTelescopeExtensionRegistry,
  setTelescopeRuntime,
} from '../src/registry.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

/**
 * Wires `@agora/telescope` into the AdonisJS application.
 *
 * - `register()` binds {@link TelescopeService} into the container, resolving against
 *   whichever store the provider builds at boot, so controllers can `inject()` it.
 * - `boot()` reads `config/telescope.ts`, builds the configured store (a key of
 *   `config.stores`, the `'memory'` shorthand, or a supplied instance), publishes it on
 *   the global runtime slot (so the request middleware can reach it without DI), and
 *   starts the {@link DiagnosticsWatcher} when the `diagnostics` watcher is enabled.
 *   Building the store is async because a driver lazily imports its peer dependency
 *   (`@adonisjs/lucid` for `lucid`) only when it is the selected one.
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
    // The store is built asynchronously at boot (a driver may lazily import its peer
    // dep). Bind the service to resolve against the active store; `boot()` runs before
    // any request, so the store is always set by the time a controller resolves it.
    this.app.container.singleton(TelescopeService, () => {
      const store = this.store ?? new InMemoryTelescopeStore();
      return new TelescopeService(store);
    });
  }

  async boot() {
    const config = resolveConfig(this.app.config.get<TelescopeConfig>('telescope', {}));
    const store = this.applyRedaction(await this.buildStore(config), config);
    this.store = store;

    if (!config.enabled) {
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

  /**
   * Build the active store from config. A supplied {@link TelescopeStore} instance is used
   * as-is; otherwise `config.store` names a driver in `config.stores`, built via its lazy
   * thunk. The bare `'memory'` shorthand (no matching driver) falls back to the built-in
   * ring buffer so `node ace configure`'s zero-config default just works.
   */
  private async buildStore(config: ResolvedTelescopeConfig): Promise<TelescopeStore> {
    if (typeof config.store !== 'string') return config.store;

    const provider = config.stores[config.store];
    if (provider) return provider({ app: this.app });

    if (config.store === 'memory') {
      return new InMemoryTelescopeStore({ maxEntries: config.maxEntries });
    }

    throw new Error(
      `@agora/telescope: config.store is "${config.store}", but config.stores.${config.store} is not defined`,
    );
  }

  /**
   * Wrap the built store with the CENTRAL redaction decorator so every entry's
   * content is scrubbed before persistence — the single choke point every watcher
   * records through (see {@link RedactingTelescopeStore}). Skipped only when
   * `config.redact.enabled` is `false`.
   */
  private applyRedaction(store: TelescopeStore, config: ResolvedTelescopeConfig): TelescopeStore {
    if (!config.redact.enabled) return store;
    return new RedactingTelescopeStore(store, { keys: config.redact.keys });
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
