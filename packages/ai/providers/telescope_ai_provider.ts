import type { ApplicationService } from '@adonisjs/core/types';
import { type TelescopeAiConfig, resolveConfig } from '../src/define_config.js';
import { createDiagnoser } from '../src/factory.js';
import { TelescopeAiDiagnoser } from '../src/telescope_ai_diagnoser.js';

/**
 * Wires `@agora/telescope-ai` into the AdonisJS application.
 *
 * - `register()` reads `config/telescope_ai.ts` (falling back to an `ai_config`
 *   key on `config/telescope.ts`), constructs a {@link TelescopeAiDiagnoser}
 *   backed by the Anthropic Claude API, and binds it into the container so
 *   controllers / the dashboard can `inject()` it. When AI is disabled or no API
 *   key resolved, a disabled diagnoser is bound (its `diagnose` is a no-op
 *   returning `null`), so consumers can inject unconditionally.
 *
 * Diagnosis never throws into the app: a model or parse failure resolves to `null`.
 */
export default class TelescopeAiProvider {
  constructor(protected app: ApplicationService) {}

  private resolve() {
    const own = this.app.config.get<TelescopeAiConfig | undefined>('telescope_ai', undefined);
    if (own !== undefined) return resolveConfig(own);

    const fromTelescope = this.app.config.get<TelescopeAiConfig | undefined>(
      'telescope.ai_config',
      undefined,
    );
    return resolveConfig(fromTelescope);
  }

  register() {
    const config = this.resolve();
    this.app.container.singleton(TelescopeAiDiagnoser, () => {
      const diagnoser = createDiagnoser(config);
      if (diagnoser !== null) return diagnoser;
      // No key / disabled: bind a diagnoser whose `diagnose` is a no-op so
      // consumers can `inject(TelescopeAiDiagnoser)` without a null check.
      return new TelescopeAiDiagnoser({
        client: { messages: { create: () => Promise.reject(new Error('disabled')) } },
        model: config.model,
        maxTokens: config.maxTokens,
        enabled: false,
      });
    });
  }
}
