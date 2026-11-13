import type { ResolvedTelescopeConfig } from '../define_config.js';
import type { ExtensionContext } from '../extension/types.js';
import { getEnabledWatchers, getTelescopeRuntime } from '../registry.js';
import { TelescopeService } from '../service.js';
import type { TelescopeStore } from '../store.js';
import { TelescopeApi } from './api.js';
import type { ResolvedTelescopeUiConfig } from './define_config.js';
import { DiagnosisApi } from './diagnosis_api.js';
import { type ExtensionActionAudit, ExtensionApi } from './extension_api.js';
import { ProfilesApi } from './profiles_api.js';
import { QueueManagerApi } from './queue_manager_api.js';
import { SchedulesApi } from './schedules_api.js';

/** Every JSON handler of the console, over one store (the whole store or a tenant-scoped view). */
export interface ConsoleApis {
  api: TelescopeApi;
  diagnosisApi: DiagnosisApi;
  profilesApi: ProfilesApi;
  schedulesApi: SchedulesApi;
  extApi: ExtensionApi | null;
  queueManagerApi: QueueManagerApi;
}

/** What {@link buildConsoleApis} needs besides the store. */
export interface ConsoleApisOptions {
  coreConfig: ResolvedTelescopeConfig;
  uiConfig: Pick<ResolvedTelescopeUiConfig, 'replay'>;
  /** Resolves container bindings for extension data providers and actions. */
  container: { make(token: unknown): Promise<unknown> };
  /** Records one extension action (see {@link recordExtensionAction}). */
  audit: (record: ExtensionActionAudit) => void | Promise<void>;
}

/**
 * The console's handlers over `source`: what the `<path>/api/*` routes serve and what the
 * `telescope:*` ace commands run, so both share validation, gates and audit.
 */
export function buildConsoleApis(source: TelescopeStore, options: ConsoleApisOptions): ConsoleApis {
  const { coreConfig, uiConfig } = options;
  const runtime = getTelescopeRuntime();
  const service = new TelescopeService(source);
  const nPlusOne = coreConfig.nPlusOne.enabled
    ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold }
    : {};
  const api = new TelescopeApi(
    service,
    { ...nPlusOne },
    {
      enabled: uiConfig.replay.enabled,
      ...(uiConfig.replay.port !== undefined ? { port: uiConfig.replay.port } : {}),
      ...(uiConfig.replay.timeoutMs !== undefined ? { timeoutMs: uiConfig.replay.timeoutMs } : {}),
    },
    {
      windowMs: coreConfig.pulse.windowMs,
      topN: coreConfig.pulse.topN,
      buckets: coreConfig.pulse.buckets,
      slowRouteMs: coreConfig.pulse.slowRouteMs,
      cards: coreConfig.pulse.cards,
      ...nPlusOne,
    },
    { prune: coreConfig.prune, sampling: coreConfig.sampling },
  );
  const registry = runtime.registry;
  const extApi = registry
    ? new ExtensionApi(
        registry,
        {
          store: source,
          container: { make: <T>(token: unknown) => options.container.make(token) as Promise<T> },
          config: coreConfig,
        } satisfies ExtensionContext,
        options.audit,
      )
    : null;
  return {
    api,
    // Each reads the runtime slot its provider fills; `null` there makes the handler answer 404.
    diagnosisApi: new DiagnosisApi(service, runtime.diagnosisCoordinator),
    profilesApi: new ProfilesApi(service, runtime.cpuProfiler),
    schedulesApi: new SchedulesApi(service),
    extApi,
    queueManagerApi: new QueueManagerApi(runtime.queueManager),
  };
}

/**
 * The audit of one extension action: an `info` log line (when a logger is given), plus a
 * `diagnostic` entry tagged `lib:telescope`, `event:extension-action` so it shows up in telescope.
 */
export async function recordExtensionAction(
  store: TelescopeStore,
  record: ExtensionActionAudit,
  logger?: { info(obj: unknown, msg?: string): void } | null,
): Promise<void> {
  const input = JSON.stringify(record.input);
  try {
    logger?.info(
      {
        telescopeAction: `${record.ext}/${record.action}`,
        caller: record.caller,
        ok: record.ok,
        ms: record.ms,
        input: input.length > 1024 ? `${input.slice(0, 1024)}…` : input,
        ...(record.error !== undefined ? { error: record.error } : {}),
      },
      '[@adonis-agora/telescope] extension action',
    );
  } catch {
    // A logger failure: the entry below is the record.
  }
  await store.record({
    type: 'diagnostic',
    content: {
      v: 1,
      lib: 'telescope',
      event: 'extension-action',
      ts: Date.now(),
      traceId: null,
      payload: record,
      durationMs: record.ms,
    },
    tags: [
      'lib:telescope',
      'event:extension-action',
      `ext:${record.ext}`,
      `action:${record.action}`,
      `caller:${record.caller}`,
      record.ok ? 'status:ok' : 'status:error',
    ],
    familyHash: 'telescope:extension-action',
    durationMs: record.ms,
  });
}

/** Why a queue mutation is refused: `telescope_ui.queueActions.enabled` is off (the default). */
export const QUEUE_ACTIONS_DISABLED =
  'Queue actions are disabled (set telescope_ui `queueActions.enabled: true`).';

/** What `GET <path>/api/meta` answers: the features that are on, and what extensions contributed. */
export function consoleMeta(apis: ConsoleApis): Record<string, unknown> {
  const runtime = getTelescopeRuntime();
  const registry = runtime.registry;
  return {
    entryTypes: registry?.entryTypes() ?? [],
    dashboards: registry?.dashboards() ?? [],
    ...(registry ? { actions: registry.actions() } : {}),
    ai: { enabled: apis.diagnosisApi.isConfigured() },
    profiling: { enabled: apis.profilesApi.isConfigured() },
    queueManager: { enabled: apis.queueManagerApi.isConfigured() },
    // The watcher names actually running, so a panel can say "the `query` watcher is off" instead
    // of reporting its own blindness as good news.
    watchers: getEnabledWatchers(),
  };
}
