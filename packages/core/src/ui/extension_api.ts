import type { ExtensionRegistry } from '../extension/registry.js';
import type { ExtensionContext } from '../extension/types.js';
import type { UiHttpContext } from './http.js';

/**
 * JSON handlers for the extension SDK surface: dashboard/entry-type metadata and the per-panel data
 * providers. Framework-light (same {@link UiHttpContext} as {@link TelescopeApi}), so they unit-test
 * against a plain request/response. Constructed with the booted {@link ExtensionRegistry} and the
 * {@link ExtensionContext} provider resolves run against.
 */
export class ExtensionApi {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly ctx: ExtensionContext,
  ) {}

  /**
   * `GET /api/meta` — the dashboards + entry types contributed by every extension, plus whatever
   * `extra` fields the provider merges in (e.g. `{ ai: { enabled } }` — additive, unrelated to the
   * extension SDK, but `/meta` is the one endpoint the dashboard always fetches on boot).
   */
  meta(http: UiHttpContext, extra: Record<string, unknown> = {}): unknown {
    return http.response.status(200).send({
      data: {
        entryTypes: this.registry.entryTypes(),
        dashboards: this.registry.dashboards(),
        ...extra,
      },
    });
  }

  /**
   * `GET /api/ext/:ext/data/:provider` — resolve a named data provider. The `:ext` segment must be
   * the provider's owning extension (namespace check), so one extension can't be addressed under
   * another's name. The panel's request query string is passed through to `resolve`.
   */
  async data(http: UiHttpContext, ext: string, providerName: string): Promise<unknown> {
    const owner = this.registry.providerOwner(providerName);
    if (owner === undefined || owner !== ext) {
      return http.response
        .status(404)
        .send({ error: `Unknown data provider "${ext}/${providerName}"` });
    }
    const provider = this.registry.findProvider(providerName);
    if (!provider) {
      return http.response.status(404).send({ error: `Unknown data provider "${providerName}"` });
    }
    try {
      const result = await provider.resolve(http.request.qs(), this.ctx);
      return http.response.status(200).send({ data: result });
    } catch (err) {
      return http.response
        .status(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}
