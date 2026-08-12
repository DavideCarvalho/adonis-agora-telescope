import type { ApplicationService } from '@adonisjs/core/types';
import { type TelescopeCpuProfilingConfig, resolveConfig } from '../src/profiling/define_config.js';
import { ProfilerService } from '../src/profiling/profiler_service.js';
import { setTelescopeCpuProfiler } from '../src/registry.js';

/**
 * Wires `@adonis-agora/telescope/cpu_profiling` into the AdonisJS application.
 *
 * A genuinely new capability (not a NestJS port glued onto Adonis) built on `node:inspector`'s
 * `Profiler.start`/`Profiler.stop` — the same V8 sampling-profiler protocol `nestjs-telescope`'s
 * `ProfilerService` uses, which is framework-agnostic (see `src/profiling/cpu-profiler.ts`). Only
 * this provider (the registration/lifecycle glue) and `TelescopeMiddleware`'s begin/end hook
 * (`src/telescope_middleware.ts`) are AdonisJS-specific.
 *
 * - `register()` reads `config/telescope_cpu_profiling.ts` (falling back to a `cpu_profiling_config`
 *   key on `config/telescope.ts`, mirroring the AI provider's fallback convention), constructs a
 *   {@link ProfilerService}, and publishes it on the runtime slot the middleware + UI routes read
 *   (no DI — the middleware already reads the runtime slot for the store/AI coordinator, so this
 *   follows that same established seam rather than introducing a new one).
 * - While disabled (the default — profiling carries real CPU overhead), the published service's
 *   `shouldProfile`/`begin` are single boolean checks that return `false`/`null`; `node:inspector`
 *   is never required.
 * - `shutdown()` clears the slot so a re-registering app (tests / HMR) doesn't read a stale service.
 */
export default class TelescopeCpuProfilingProvider {
  constructor(protected app: ApplicationService) {}

  private resolve() {
    const own = this.app.config.get<TelescopeCpuProfilingConfig | undefined>(
      'telescope_cpu_profiling',
      undefined,
    );
    if (own !== undefined) return resolveConfig(own);

    const fromTelescope = this.app.config.get<TelescopeCpuProfilingConfig | undefined>(
      'telescope.cpu_profiling_config',
      undefined,
    );
    return resolveConfig(fromTelescope);
  }

  register() {
    const config = this.resolve();
    const profiler = new ProfilerService(config);
    this.app.container.singleton(ProfilerService, () => profiler);
    setTelescopeCpuProfiler(profiler);
  }

  async shutdown() {
    setTelescopeCpuProfiler(null);
  }
}
