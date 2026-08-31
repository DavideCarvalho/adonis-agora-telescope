import type { Entry } from '../entry.js';
import { EntryType } from '../entry.js';
import type { ProfilerService, ProfilerStatus } from '../profiling/profiler_service.js';
import type { CpuProfileContent } from '../profiling/types.js';
import type { TelescopeService } from '../service.js';
import { type EntrySummary, toSummary } from './api.js';
import type { UiHttpContext } from './http.js';

/** `POST <path>/api/profiles/arm` request body. */
export interface ArmProfileBody {
  count?: unknown;
  label?: unknown;
}

/**
 * `GET/POST <path>/api/profiles/*` handlers over the OPTIONAL `@adonis-agora/telescope/cpu_profiling`
 * feature. Kept in its own class (mirroring {@link DiagnosisApi}/{@link ExtensionApi}) rather than
 * folded into {@link TelescopeApi} because it is constructed from the runtime slot
 * (`getTelescopeRuntime().cpuProfiler`), not `TelescopeApi`'s constructor args.
 *
 * Every route degrades to `404` when `profiler` is `null` (the feature isn't installed/enabled) —
 * mirroring how {@link DiagnosisApi} degrades when the AI coordinator is absent — so a dashboard
 * without CPU profiling simply doesn't see the routes rather than erroring.
 *
 * Response shapes mirror the NestJS sibling's `GET telescope/api/profiles*` /
 * `POST telescope/api/profiles/arm` contract (`status`/list/detail/arm), modulo the `{ data }`
 * envelope this package's JSON API always uses.
 */
export class ProfilesApi {
  constructor(
    private readonly service: TelescopeService,
    private readonly profiler: ProfilerService | null,
  ) {}

  /** Whether the feature is installed — surfaced on `GET <path>/api/meta`. */
  isConfigured(): boolean {
    return this.profiler !== null;
  }

  /** `GET <path>/api/profiles/status` — the profiler's current sampling/arm state. */
  status(ctx: UiHttpContext): unknown {
    if (this.profiler === null) return notConfigured(ctx);
    const data: ProfilerStatus = this.profiler.status();
    return ctx.response.status(200).header('content-type', 'application/json').send({ data });
  }

  /**
   * `GET <path>/api/profiles?limit=` — captured profiles newest-first, WITHOUT their (potentially
   * large) frame tree — the summary already omits `content` (see {@link toSummary}).
   */
  async list(ctx: UiHttpContext): Promise<unknown> {
    if (this.profiler === null) return notConfigured(ctx);
    const limitRaw = ctx.request.qs().limit;
    const limit =
      typeof limitRaw === 'string' && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 100;
    const entries = await this.service.list({ type: EntryType.CpuProfile, limit });
    const data: EntrySummary[] = entries.map(toSummary);
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data, meta: { count: data.length } });
  }

  /** `GET <path>/api/profiles/:id` — one profile's full frame tree (the flamegraph payload), or 404. */
  async show(ctx: UiHttpContext, id: string): Promise<unknown> {
    if (this.profiler === null) return notConfigured(ctx);
    const entry = await this.service.find(id);
    if (entry === null || entry.type !== EntryType.CpuProfile) {
      return ctx.response.status(404).send({ error: 'No CPU profile with that id.' });
    }
    return ctx.response
      .status(200)
      .header('content-type', 'application/json')
      .send({ data: entry as Entry<CpuProfileContent> });
  }

  /**
   * `POST <path>/api/profiles/arm` — arm an on-demand capture of the next N requests (optionally
   * only those whose label matches). A MUTATION-shaped trigger (it incurs real profiling overhead),
   * so — mirroring replay's `replay.enabled` gate — it is only reachable when the CALLER has already
   * confirmed mutations are allowed; this class doesn't own that gate (the provider composes it),
   * matching how `TelescopeApi.replayRequest` reads its own `replay.enabled` flag directly. `400`
   * when profiling itself is disabled, so the dashboard can explain why nothing happens.
   */
  arm(ctx: UiHttpContext, body: ArmProfileBody): unknown {
    if (this.profiler === null) return notConfigured(ctx);
    if (!this.profiler.status().enabled) {
      return ctx.response.status(400).send({
        error: 'CPU profiling is disabled (set telescope_cpu_profiling `enabled: true`).',
      });
    }
    const count = body?.count !== undefined ? Number(body.count) : 1;
    if (!Number.isFinite(count) || count <= 0) {
      return ctx.response.status(400).send({ error: '`count` must be a positive number.' });
    }
    const label = typeof body?.label === 'string' && body.label !== '' ? body.label : undefined;
    const data = this.profiler.arm({ count, ...(label !== undefined ? { label } : {}) });
    return ctx.response.status(200).header('content-type', 'application/json').send({ data });
  }
}

function notConfigured(ctx: UiHttpContext): unknown {
  return ctx.response
    .status(404)
    .send({ error: 'CPU profiling is not installed for this dashboard.' });
}
