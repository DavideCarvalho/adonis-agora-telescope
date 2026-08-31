import type { ExceptionEntryContent } from '../ai/diagnoser.js';
import type { DiagnosisCoordinator } from '../ai/diagnosis_coordinator.js';
import { formatDiagnosisMarkdown } from '../ai/diagnosis_coordinator.js';
import type { Entry } from '../entry.js';
import { EntryType } from '../entry.js';
import type { TelescopeService } from '../service.js';
import type { UiHttpContext } from './http.js';

/**
 * `POST <path>/api/exceptions/:id/diagnose[?force=true]` handler — the UI's entry point into the
 * AI diagnosis feature (`@adonis-agora/telescope`'s `src/ai/*`), which is otherwise only reachable
 * from the MCP `diagnose_exception` tool and the alerter.
 *
 * Kept in its own class (mirroring {@link ExtensionApi}) rather than folded into {@link TelescopeApi}
 * because it is constructed from the AI runtime slot (`getTelescopeRuntime().diagnosisCoordinator`),
 * not `TelescopeApi`'s constructor args — the same "read the optional runtime slot in the provider"
 * pattern the extension/stream routes already use.
 *
 * Response shape (`{ markdown, cached }`) intentionally mirrors the NestJS sibling's
 * `POST telescope/api/exceptions/:id/diagnose` contract so the two dashboards' AI panels can share
 * the same client/component shape, even though the underlying {@link DiagnosisCoordinator} here
 * returns a structured {@link Diagnosis} rather than markdown directly — `formatDiagnosisMarkdown`
 * bridges the two.
 *
 * Unlike the NestJS sibling there is no side-effect-free "peek cached" verb on
 * {@link DiagnosisCoordinator} (it does not expose the underlying diagnoser's cache), so there is
 * deliberately no read-only `GET .../diagnosis` route here — the dashboard always calls this POST
 * route, which happens to be cheap (no model call) when the family is already cached.
 */
export class DiagnosisApi {
  constructor(
    private readonly service: TelescopeService,
    private readonly coordinator: DiagnosisCoordinator | null,
  ) {}

  /** Whether the AI feature is installed and configured — surfaced on `GET <path>/api/meta`. */
  isConfigured(): boolean {
    return this.coordinator?.isConfigured() ?? false;
  }

  async diagnose(ctx: UiHttpContext, id: string, force: boolean): Promise<unknown> {
    if (this.coordinator === null || !this.coordinator.isConfigured()) {
      return ctx.response
        .status(404)
        .send({ error: 'AI diagnosis is not configured for this dashboard.' });
    }

    const entry = await this.service.find(id);
    if (entry === null || !isExceptionLike(entry)) {
      return ctx.response.status(404).send({ error: 'No exception entry with that id.' });
    }

    const diagnosis = await this.coordinator.diagnose(entry as Entry<ExceptionEntryContent>, {
      force,
    });
    if (diagnosis === null) {
      return ctx.response.status(502).send({ error: 'AI diagnosis failed or timed out.' });
    }

    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: { markdown: formatDiagnosisMarkdown(diagnosis), cached: diagnosis.cached } });
  }
}

function isExceptionLike(entry: Entry): boolean {
  return entry.type === EntryType.Exception || entry.type === EntryType.ClientException;
}
