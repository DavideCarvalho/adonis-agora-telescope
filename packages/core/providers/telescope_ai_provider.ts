import type { ApplicationService } from '@adonisjs/core/types';
import { resolveConfig, type TelescopeAiConfig } from '../src/ai/define_config.js';
import { DiagnosisCoordinator } from '../src/ai/diagnosis_coordinator.js';
import { createDiagnoser } from '../src/ai/factory.js';
import { TelescopeAiDiagnoser } from '../src/ai/telescope_ai_diagnoser.js';
import { setTelescopeDiagnosisCoordinator } from '../src/registry.js';

/**
 * Wires `@adonis-agora/telescope/ai` into the AdonisJS application.
 *
 * - `register()` reads `config/telescope_ai.ts` (falling back to an `ai_config`
 *   key on `config/telescope.ts`), constructs a {@link TelescopeAiDiagnoser}
 *   backed by the Anthropic Claude API, and binds it into the container so
 *   controllers / the dashboard can `inject()` it. When AI is disabled or no API
 *   key resolved, a disabled diagnoser is bound (its `diagnose` is a no-op
 *   returning `null`), so consumers can inject unconditionally.
 * - `register()` also constructs a {@link DiagnosisCoordinator} (wrapping the
 *   resolved diagnoser, or a `null` diagnoser when AI is off) and publishes it into
 *   the core runtime slot. That single seam is what the MCP `diagnose_exception`
 *   tool and the alerter read (no DI) to attach probable-cause analysis. Publishing
 *   in `register()` — before ANY provider's `boot()` — guarantees the coordinator
 *   is in the slot when the MCP / alerts providers boot, regardless of order.
 *
 * Diagnosis never throws into the app: a model or parse failure resolves to `null`,
 * and the coordinator additionally timeout-bounds and swallows every failure.
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
    // The real diagnoser, or `null` when AI is disabled / no provider resolved.
    const diagnoser = createDiagnoser(config);

    this.app.container.singleton(TelescopeAiDiagnoser, () => {
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

    // Build + publish the coordinator. When `diagnoser` is `null` the coordinator
    // is inert (`isConfigured()` is false), so the MCP tool and the alerter both
    // keep their exact non-AI behaviour.
    const coordinator = new DiagnosisCoordinator({ diagnoser, timeoutMs: config.timeoutMs });
    this.app.container.singleton(DiagnosisCoordinator, () => coordinator);
    setTelescopeDiagnosisCoordinator(coordinator);
  }

  async shutdown() {
    // Clear the slot so a re-registering app (tests / HMR) doesn't read a stale one.
    setTelescopeDiagnosisCoordinator(null);
  }
}
