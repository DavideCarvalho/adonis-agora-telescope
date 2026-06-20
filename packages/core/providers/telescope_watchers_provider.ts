import type { ApplicationService } from '@adonisjs/core/types';
import { CacheWatcher } from '../src/watchers/cache_watcher.js';
import {
  type ResolvedTelescopeWatchersConfig,
  type TelescopeWatchersConfig,
  resolveConfig,
} from '../src/watchers/define_config.js';
import type { EmitterLike, Watcher } from '../src/watchers/emitter.js';
import { LucidQueryWatcher } from '../src/watchers/lucid_query_watcher.js';
import { MailWatcher } from '../src/watchers/mail_watcher.js';

/**
 * Wires `@agora/telescope/watchers` into the AdonisJS application.
 *
 * - `boot()` reads `config/telescope_watchers.ts` (falling back to a `watchers`
 *   key on `config/telescope.ts`), resolves the application emitter from the
 *   container, and starts each enabled watcher against it. Each watcher records
 *   through `@agora/telescope`'s runtime store handle — no DI required.
 * - `shutdown()` stops every started watcher (full unsubscribe).
 *
 * Watchers never throw into the app: a missing config, a missing emitter, or a
 * disabled telescope all degrade to recording nothing.
 */
export default class TelescopeWatchersProvider {
  private readonly started: Watcher[] = [];

  constructor(protected app: ApplicationService) {}

  /** Read the watchers config from its own file or the telescope config block. */
  private resolve(): ResolvedTelescopeWatchersConfig {
    const own = this.app.config.get<TelescopeWatchersConfig | undefined>(
      'telescope_watchers',
      undefined,
    );
    if (own !== undefined) return resolveConfig(own);

    // Fall back to a `watchers` block on the main telescope config, if present.
    const fromTelescope = this.app.config.get<TelescopeWatchersConfig | undefined>(
      'telescope.watchers_config',
      undefined,
    );
    return resolveConfig(fromTelescope);
  }

  async boot() {
    const config = this.resolve();
    if (!config.enabled) return;

    let emitter: EmitterLike;
    try {
      emitter = (await this.app.container.make('emitter')) as unknown as EmitterLike;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TelescopeWatchersProvider: could not resolve the emitter: ${message}`);
      return;
    }

    if (config.watchers.has('query')) this.startWatcher(new LucidQueryWatcher(), emitter);
    if (config.watchers.has('mail')) this.startWatcher(new MailWatcher(), emitter);
    if (config.watchers.has('cache')) this.startWatcher(new CacheWatcher(), emitter);
  }

  /** Start one watcher, never letting a watcher's `start` break boot. */
  private startWatcher(watcher: Watcher, emitter: EmitterLike): void {
    try {
      watcher.start(emitter);
      this.started.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `TelescopeWatchersProvider: failed to start ${watcher.type} watcher: ${message}`,
      );
    }
  }

  async shutdown() {
    for (const watcher of this.started) {
      try {
        watcher.stop();
      } catch {
        // never throw out of shutdown
      }
    }
    this.started.length = 0;
  }
}
