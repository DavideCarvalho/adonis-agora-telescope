import { currentTraceId } from '../context_accessor.js';
import type { RecordInput } from '../entry.js';
import { getTelescopeRuntime } from '../registry.js';
import type { TelescopeStore } from '../store.js';

/**
 * Resolve the active telescope store WITHOUT dependency injection. `@adonis-agora/telescope`'s
 * provider publishes the live store on a cross-copy-stable global slot at boot
 * (see its `registry.ts`); the request middleware records through that same handle.
 * Reusing it here lets these watchers record from inside synchronous emitter
 * subscribers — where there is no container to `inject()` from — and degrade to a
 * no-op when telescope is disabled or not booted.
 */
export function resolveStore(): TelescopeStore | null {
  return getTelescopeRuntime().store;
}

/**
 * Record one entry through the runtime store, swallowing every failure. Watchers
 * run inside emitter subscribers on the host's hot paths, so this is strictly
 * fire-and-forget: a missing store, a throwing `record`, or a rejected promise can
 * never break (or block) the emit it is observing.
 *
 * The active `@adonis-agora/context` trace id is backfilled when the caller did not set
 * `traceId` explicitly, mirroring how the core watchers correlate entries.
 */
export function safeRecord(input: RecordInput, source: string): void {
  let store: TelescopeStore | null;
  try {
    store = resolveStore();
  } catch (err) {
    reportError(source, err);
    return;
  }
  if (!store) return;

  try {
    const resolved: RecordInput =
      input.traceId === undefined ? { ...input, traceId: currentTraceId() } : input;
    // Fire-and-forget: the store is async but the subscriber is sync. Swallow
    // rejections so an observed code path is never affected by telescope.
    void Promise.resolve(store.record(resolved)).catch((err) => reportError(source, err));
  } catch (err) {
    reportError(source, err);
  }
}

function reportError(source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${source}: failed to record telescope entry: ${message}`);
}
