import type { ExceptionEntryContent } from '../ai/diagnoser.js';
import type { ResolvedTelescopeConfig } from '../define_config.js';
import type { Entry } from '../entry.js';
import { MetricsService } from '../metrics/metrics_service.js';
import { getTelescopeRuntime } from '../registry.js';
import { TelescopeService } from '../service.js';
import type { TelescopeStore } from '../store.js';
import type { McpToolName } from './define_config.js';
import { VERSION } from './index.js';
import { type DiagnoseExceptionHook, TelescopeMcpServer } from './server.js';

/**
 * Build the {@link TelescopeMcpServer} both MCP surfaces share (`/telescope/mcp` and the dev tools
 * registered into `'agora.devTools'`): the same services over the live store, and the AI diagnosis
 * hook when a configured coordinator is published.
 */
export function buildTelescopeMcpServer(
  store: TelescopeStore,
  coreConfig: ResolvedTelescopeConfig,
  tools?: ReadonlySet<McpToolName>,
): TelescopeMcpServer {
  const service = new TelescopeService(store, {
    windowMs: coreConfig.pulse.windowMs,
    topN: coreConfig.pulse.topN,
    buckets: coreConfig.pulse.buckets,
    slowRouteMs: coreConfig.pulse.slowRouteMs,
    cards: coreConfig.pulse.cards,
    ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
  });
  const metrics = new MetricsService(store, {
    ...(coreConfig.nPlusOne.enabled ? { nPlusOneThreshold: coreConfig.nPlusOne.threshold } : {}),
  });
  // Wire the AI diagnosis hook only when a configured coordinator is published; without one
  // `diagnose_exception` reports "not configured".
  const coordinator = getTelescopeRuntime().diagnosisCoordinator;
  const diagnose: DiagnoseExceptionHook | undefined = coordinator?.isConfigured()
    ? async (entry: Entry) => {
        // Feed the same-trace siblings as extra context (already redacted).
        const related = entry.traceId !== null ? await service.byTrace(entry.traceId) : undefined;
        return coordinator.diagnoseMarkdown(entry as Entry<ExceptionEntryContent>, {
          ...(related !== undefined ? { related } : {}),
        });
      }
    : undefined;

  return new TelescopeMcpServer(service, metrics, {
    ...(tools !== undefined ? { tools } : {}),
    // Sourced from the package's VERSION const (kept in lockstep with package.json).
    serverInfo: { name: 'adonis-telescope', version: VERSION },
    ...(diagnose !== undefined ? { diagnose } : {}),
  });
}
