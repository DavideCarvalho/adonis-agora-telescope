import { AsyncLocalStorage } from 'node:async_hooks';
import { type BatchOrigin, isBatchOrigin } from './entry.js';

/**
 * What an ambient scope says about the code currently running.
 *
 * `origin` labels WHERE the work came from — an HTTP request, a queue job, the
 * scheduler's tick. Until this existed only the request watcher ever set an
 * origin (explicitly, per entry), so everything a worker process recorded landed
 * as `manual`: the `queue` / `schedule` / `cli` members of {@link BatchOrigin}
 * were declared and never written by anyone.
 *
 * `heartbeat` marks the narrower thing: a liveness PROBE. A scheduler asking the
 * store "is there anything to do?" is not an event — it is the system breathing.
 * In one measured production window those probes were 57% of every entry
 * telescope held, which is how a debugging tool stops being one.
 */
export interface OriginScope {
  origin?: BatchOrigin;
  heartbeat?: boolean;
}

/**
 * The narrow surface published on a cross-copy-stable global slot so SIBLING
 * Agora libraries can label their own work without importing telescope — the
 * same stance `@adonis-agora/context` takes with its accessor, and for the same
 * reason: `@adonis-agora/durable` is a separate repo and must not grow a
 * dependency on an observability tool just to be observable.
 *
 * A lib reads this slot structurally and degrades to running `fn` unwrapped when
 * telescope is absent.
 */
export interface OriginScopeDriver {
  /** Run `fn` inside `scope`, merged over whatever scope is already active. */
  run<T>(scope: OriginScope, fn: () => T): T;
  /** The active scope, or `undefined` outside one. */
  current(): OriginScope | undefined;
}

/** The global slot {@link OriginScopeDriver} is published on. */
export const ORIGIN_SCOPE_KEY = Symbol.for('@agora/telescope:origin-scope');

const globalSlot = globalThis as Record<symbol, unknown>;

function createDriver(): OriginScopeDriver {
  const storage = new AsyncLocalStorage<OriginScope>();
  return {
    run<T>(scope: OriginScope, fn: () => T): T {
      // Merge over the enclosing scope rather than replacing it: a heartbeat probe
      // inside the scheduler's tick must stay `origin: 'schedule'` AND become a
      // heartbeat, not lose the origin on the way in.
      const merged: OriginScope = { ...storage.getStore(), ...scope };
      return storage.run(merged, fn);
    },
    current: () => storage.getStore(),
  };
}

/**
 * One driver per process, even when several copies of this package are loaded:
 * an `AsyncLocalStorage` created by copy A is invisible to copy B, so the FIRST
 * copy to load wins and every later one reuses its instance through the slot.
 */
const driver: OriginScopeDriver =
  (globalSlot[ORIGIN_SCOPE_KEY] as OriginScopeDriver | undefined) ?? createDriver();
globalSlot[ORIGIN_SCOPE_KEY] = driver;

/** The shared driver — what the global slot holds. */
export function getOriginScopeDriver(): OriginScopeDriver {
  return driver;
}

/** Run `fn` labelled as coming from `origin` (e.g. `'schedule'` around a worker tick). */
export function runWithOrigin<T>(origin: BatchOrigin, fn: () => T): T {
  return driver.run({ origin }, fn);
}

/**
 * Run `fn` marked as a liveness PROBE. Wrap only the probe itself — the store read
 * that asks "is there work?" — never the work it finds. A tick that picks up a run
 * must still record everything it then does.
 */
export function runAsHeartbeat<T>(fn: () => T): T {
  return driver.run({ heartbeat: true }, fn);
}

/** The ambient origin, or `null` outside a scope (callers fall back to `'manual'`). */
export function currentOrigin(): BatchOrigin | null {
  const origin = driver.current()?.origin;
  return isBatchOrigin(origin) ? origin : null;
}

/** Whether the caller is inside a {@link runAsHeartbeat} probe. */
export function isHeartbeat(): boolean {
  return driver.current()?.heartbeat === true;
}

/**
 * The origin to persist for an entry: an explicit per-entry override wins, then
 * the ambient scope, then `manual`. The one place the precedence is decided, so
 * the two stores cannot drift.
 */
export function resolveOrigin(explicit: unknown): BatchOrigin {
  if (isBatchOrigin(explicit)) return explicit;
  return currentOrigin() ?? 'manual';
}
