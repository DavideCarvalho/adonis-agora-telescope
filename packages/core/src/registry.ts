import type { DiagnosisCoordinator } from './ai/diagnosis_coordinator.js';
import type { ExtensionRegistry } from './extension/registry.js';
import type { RequestCaptureOptions } from './request_watcher.js';
import type { TelescopeStore } from './store.js';
import type { EntryEvents } from './stream/entry_events.js';

/**
 * The live runtime telescope handles, published on a cross-copy-stable global slot
 * so the request middleware can reach the active store WITHOUT constructor wiring
 * — mirroring the "singleton lives outside the container" stance the Agora
 * ecosystem uses for context/diagnostics. The provider sets this at boot and
 * clears it at shutdown.
 */
export interface TelescopeRuntime {
  /** The active store, or `null` when telescope is disabled / not booted. */
  store: TelescopeStore | null;
  /** Whether the request watcher should record. */
  requestWatcherEnabled: boolean;
  /**
   * Resolved request body-capture gates the middleware feeds to the request
   * watcher, or `null` when body capture is off (the default). See
   * {@link RequestCaptureOptions}.
   */
  requestCapture: RequestCaptureOptions | null;
  /** The booted extension registry (entry types / dashboards / data providers), or `null`. */
  registry: ExtensionRegistry | null;
  /**
   * The live SSE entry-events bus the store's write path publishes persisted
   * entries to and the UI stream route subscribes to, or `null` when live
   * streaming is disabled / not booted.
   */
  entryEvents: EntryEvents | null;
  /**
   * Overload-shed flag. While `true` (set by the overload guard when the event
   * loop is lagging) every ingestion entry point — the request middleware and the
   * watcher `safeRecord` helper — drops new entries so telescope can never amplify
   * an incident. Reset to `false` on boot/shutdown and when load recovers.
   */
  paused: boolean;
  /**
   * The AI diagnosis coordinator published by the AI provider, or `null` when the
   * AI feature is not installed. The MCP `diagnose_exception` tool and the alerter
   * read it from here (no DI) to attach probable-cause analysis; when `null` — or
   * when its `isConfigured()` is `false` — both degrade to their non-AI behaviour.
   */
  diagnosisCoordinator: DiagnosisCoordinator | null;
}

const RUNTIME_KEY = Symbol.for('@agora/telescope:runtime');
const globalStore = globalThis as typeof globalThis & { [RUNTIME_KEY]?: TelescopeRuntime };

const runtime: TelescopeRuntime = globalStore[RUNTIME_KEY] ?? {
  store: null,
  requestWatcherEnabled: false,
  requestCapture: null,
  registry: null,
  entryEvents: null,
  paused: false,
  diagnosisCoordinator: null,
};
globalStore[RUNTIME_KEY] = runtime;

/** The shared runtime handle. */
export function getTelescopeRuntime(): TelescopeRuntime {
  return runtime;
}

/** Install the active store + flags (called by the provider at boot). */
export function setTelescopeRuntime(
  store: TelescopeStore,
  requestWatcherEnabled: boolean,
  requestCapture: RequestCaptureOptions | null = null,
): void {
  runtime.store = store;
  runtime.requestWatcherEnabled = requestWatcherEnabled;
  runtime.requestCapture = requestCapture;
}

/** Publish the booted extension registry so the UI can serve its dashboards + providers. */
export function setTelescopeExtensionRegistry(registry: ExtensionRegistry | null): void {
  runtime.registry = registry;
}

/** Publish the SSE entry-events bus so the UI stream route can subscribe to it. */
export function setTelescopeEntryEvents(entryEvents: EntryEvents | null): void {
  runtime.entryEvents = entryEvents;
}

/**
 * Publish the AI diagnosis coordinator (called by the AI provider at register) so
 * the MCP tool and the alerter can attach probable-cause analysis. Pass `null` to
 * clear it (AI disabled / provider shutdown).
 */
export function setTelescopeDiagnosisCoordinator(coordinator: DiagnosisCoordinator | null): void {
  runtime.diagnosisCoordinator = coordinator;
}

/**
 * Toggle the overload-shed flag (called by the overload guard). While paused,
 * every ingestion entry point drops new entries. Idempotent.
 */
export function setTelescopePaused(paused: boolean): void {
  runtime.paused = paused;
}

/** Tear down the runtime (called by the provider at shutdown). */
export function resetTelescopeRuntime(): void {
  runtime.store = null;
  runtime.requestWatcherEnabled = false;
  runtime.requestCapture = null;
  runtime.registry = null;
  runtime.entryEvents = null;
  runtime.paused = false;
  runtime.diagnosisCoordinator = null;
}
