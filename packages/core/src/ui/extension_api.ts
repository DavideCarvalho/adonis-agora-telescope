import type { ExtensionRegistry } from '../extension/registry.js';
import type { ExtensionActionCaller, ExtensionContext } from '../extension/types.js';
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
    private readonly audit: (record: ExtensionActionAudit) => void | Promise<void> = () => {},
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

  /**
   * `POST /api/ext/:ext/actions/:action` — run a named extension action. The body is
   * `{ confirmed: true, input?: {...} }`: without `confirmed: true` the call is refused (`400`), so
   * a stray request cannot trigger a write the viewer never confirmed. `:ext` must own the action
   * (namespace check, like data providers). Every attempt that reaches the action is audited.
   */
  async action(
    http: UiHttpContext,
    ext: string,
    actionName: string,
    body: Record<string, unknown>,
    caller: ExtensionActionCaller,
  ): Promise<unknown> {
    const owner = this.registry.actionOwner(actionName);
    const action = owner === ext ? this.registry.findAction(actionName) : undefined;
    if (action === undefined) {
      return http.response.status(404).send({ error: `Unknown action "${ext}/${actionName}"` });
    }
    if (body.confirmed !== true) {
      return http.response
        .status(400)
        .send({ error: 'This action needs an explicit confirmation (confirmed: true).' });
    }
    const raw = body.input;
    const input =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const started = Date.now();
    try {
      const result = await action.run(input, { ...this.ctx, caller, http });
      await this.safeAudit({
        ext,
        action: actionName,
        caller: caller.id,
        input,
        ok: true,
        ms: Date.now() - started,
      });
      return http.response.status(200).send({ data: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ext,
        action: actionName,
        caller: caller.id,
        input,
        ok: false,
        ms: Date.now() - started,
        error: message,
      });
      return http.response.status(500).send({ error: message });
    }
  }

  private async safeAudit(record: ExtensionActionAudit): Promise<void> {
    try {
      await this.audit(record);
    } catch {
      // An audit sink failure never turns a done action into an error.
    }
  }
}

/** One audited extension action call. */
export interface ExtensionActionAudit {
  ext: string;
  action: string;
  caller: string;
  input: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
}
