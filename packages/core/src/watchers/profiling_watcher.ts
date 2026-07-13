import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { safeRecord } from './record.js';

/** The `type` of the entries this watcher records. */
export const PROFILE_ENTRY_TYPE = EntryType.Profile;

/** The terminal outcome of a profiling span. */
export type ProfileStatus = 'completed' | 'failed';

/** A timing mark taken inside a span, offset (ms) from the span's start. */
export interface ProfileMark {
  /** The mark label, e.g. `'validated'`, `'db-loaded'`. */
  label: string;
  /** Milliseconds elapsed from the span's start when the mark was taken. */
  atMs: number;
}

/** The recorded body of a `profile` entry. */
export interface ProfileEntryContent {
  /** The span label, e.g. `'checkout'`. */
  label: string;
  /** Total wall-clock duration of the span in milliseconds. */
  durationMs: number;
  /** The span outcome. */
  status: ProfileStatus;
  /** In-order timing marks taken inside the span (nested checkpoints). */
  marks: ProfileMark[];
  /** The failure message when `status` is `'failed'`, else `null`. */
  failureReason: string | null;
  /** The active trace id at record time, or `null`. */
  traceId: string | null;
}

/** Options for {@link ProfilingWatcher}. */
export interface ProfilingWatcherOptions {
  /** Spans at/above this many ms get a `slow` tag. Default 100. */
  slowMs?: number;
  /**
   * Spans whose duration is below this are discarded (too short to be worth a
   * timeline entry). Default `0` (keep all).
   */
  minDurationMs?: number;
  /** Time source; injectable for tests. Default `Date.now`. */
  clock?: { now(): number };
}

/** Default slow-span threshold in milliseconds. */
const DEFAULT_SLOW_MS = 100;

/**
 * An in-flight profiling span. Add {@link mark}s inside the timed section, then
 * call {@link end} (or {@link fail}) exactly once to record it. Recording is
 * fire-and-forget and fully guarded — a telescope failure can never break the
 * code being profiled.
 */
export interface ProfileSession {
  /** Take a timing mark at the current instant (offset from the span's start). */
  mark(label: string): this;
  /** Finish the span and record it as `completed`. Idempotent. */
  end(): void;
  /** Finish the span and record it as `failed` with the given error. Idempotent. */
  fail(error: unknown): void;
}

/** A no-op session returned when profiling is not enabled — zero recording cost. */
const NOOP_SESSION: ProfileSession = {
  mark() {
    return this;
  },
  end() {},
  fail() {},
};

/** The live session backed by a configured watcher. */
class ActiveProfileSession implements ProfileSession {
  private readonly marks: ProfileMark[] = [];
  private settled = false;

  constructor(
    private readonly watcher: ProfilingWatcher,
    private readonly label: string,
    private readonly startedAt: number,
  ) {}

  mark(label: string): this {
    if (this.settled) return this;
    this.marks.push({ label, atMs: Math.max(0, this.watcher.now() - this.startedAt) });
    return this;
  }

  end(): void {
    this.settle('completed', undefined);
  }

  fail(error: unknown): void {
    this.settle('failed', error);
  }

  private settle(status: ProfileStatus, error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.watcher.record({
      label: this.label,
      durationMs: Math.max(0, this.watcher.now() - this.startedAt),
      status,
      marks: this.marks,
      error,
    });
  }
}

/** A completed span handed to {@link buildProfileEntry}. */
export interface CompletedProfile {
  label: string;
  durationMs: number;
  status: ProfileStatus;
  marks: ProfileMark[];
  error?: unknown;
}

/**
 * Cross-copy-stable slot holding the provider-configured default watcher, so the
 * standalone {@link profile} / {@link startProfile} helpers inherit the app's
 * configured `slowMs` / `minDurationMs` — and, crucially, are a NO-OP until the
 * provider starts the watcher (profiling stays strictly opt-in). A `Symbol.for`
 * global slot keeps two copies of this package in agreement, mirroring the
 * http-client watcher's default-slot stance.
 */
const DEFAULT_SLOT = Symbol.for('@agora/telescope:defaultProfilingWatcher');
const slotHost = globalThis as typeof globalThis & { [DEFAULT_SLOT]?: ProfilingWatcher | null };

function setDefaultProfilingWatcher(watcher: ProfilingWatcher | null): void {
  slotHost[DEFAULT_SLOT] = watcher;
}
function getDefaultProfilingWatcher(): ProfilingWatcher | null {
  return slotHost[DEFAULT_SLOT] ?? null;
}

/**
 * Records user-instrumented profiling spans as `profile` telescope entries — one
 * per timed code section, capturing its label, total duration, in-span timing
 * marks, and outcome (completed/failed), correlated to the active trace.
 *
 * ## How it works
 * Unlike the emitter-driven watchers, profiling is DRIVEN BY THE USER: there is
 * no event to tap. Wrap a code section with {@link profile} (or bracket it with
 * {@link startProfile} + {@link ProfileSession.end}); the watcher times it and
 * records one entry. It never monkey-patches anything and carries no cost while
 * disabled — the standalone helpers are a no-op until the provider calls
 * {@link start}.
 *
 * Each entry carries `familyHash` (the label) and `durationMs`, so repeated spans
 * of the same label roll up and feed the slow-hotspot metrics cards. Recording is
 * fire-and-forget and fully guarded: a telescope failure can never break the code
 * being profiled.
 *
 * Idiomatic Adonis: a plain class, no DI decorators. The provider constructs it
 * from `config/telescope_watchers.ts` and calls {@link start} to publish it as the
 * default backing the bare {@link profile} / {@link startProfile} helpers;
 * {@link stop} unpublishes.
 */
export class ProfilingWatcher {
  readonly type = EntryType.Profile;
  private readonly slowMs: number;
  private readonly minDurationMs: number;
  private readonly clock: { now(): number };

  constructor(options: ProfilingWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.minDurationMs = Math.max(0, options.minDurationMs ?? 0);
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  /** The watcher's time source (used by its sessions). */
  now(): number {
    return this.clock.now();
  }

  /** Publish this configured instance as the default the standalone
   *  {@link profile} / {@link startProfile} helpers inherit. Does NOT patch any
   *  global. Named `start`/`stop` to match the other watchers' provider lifecycle. */
  start(): void {
    setDefaultProfilingWatcher(this);
  }

  /** Unpublish this instance as the default (if it is). Never touches globals. */
  stop(): void {
    if (getDefaultProfilingWatcher() === this) setDefaultProfilingWatcher(null);
  }

  /** Begin a profiling span. Add marks on the returned session, then `end()`/`fail()`. */
  startProfile(label: string): ProfileSession {
    return new ActiveProfileSession(this, label, this.clock.now());
  }

  /**
   * Time `fn` as a profiling span. The span's session is passed to `fn` so it can
   * add timing marks. Records `completed` on return / resolve and `failed` on
   * throw / reject, always re-throwing so the caller's control flow is untouched.
   * Works with sync and async `fn`.
   */
  profile<T>(label: string, fn: (session: ProfileSession) => T): T {
    const session = this.startProfile(label);
    let result: T;
    try {
      result = fn(session);
    } catch (error) {
      session.fail(error);
      throw error;
    }
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          session.end();
          return value;
        },
        (error: unknown) => {
          session.fail(error);
          throw error;
        },
      ) as T;
    }
    session.end();
    return result;
  }

  /** Record one already-completed span. Spans below `minDurationMs` are dropped;
   *  recording is fire-and-forget and never throws. */
  record(profile: CompletedProfile): void {
    if (profile.durationMs < this.minDurationMs) return;
    safeRecord(buildProfileEntry(profile, this.slowMs), 'ProfilingWatcher');
  }
}

/** Narrow a value to a thenable so async `fn`s are awaited without importing a Promise type. */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Map a completed span to a telescope {@link RecordInput}. Exported so the entry
 *  shape can be unit-tested without a live watcher. */
export function buildProfileEntry(
  profile: CompletedProfile,
  slowMs = DEFAULT_SLOW_MS,
): RecordInput<ProfileEntryContent> {
  const durationMs = Math.max(0, profile.durationMs);
  const failed = profile.status === 'failed';
  const failureReason = failed && profile.error !== undefined ? errorMessage(profile.error) : null;
  const traceId = currentTraceId();

  const content: ProfileEntryContent = {
    label: profile.label,
    durationMs,
    status: profile.status,
    marks: profile.marks,
    failureReason,
    traceId,
  };

  const tags: string[] = ['profile', `profile:${profile.label}`];
  if (failed) tags.push('failed');
  if (durationMs >= slowMs) tags.push('slow');

  return {
    type: EntryType.Profile,
    // Group by label so every run of the same span rolls up — the slow-hotspot key.
    familyHash: `profile:${profile.label}`,
    content,
    durationMs,
    traceId,
    tags,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Begin a profiling span through the provider-published default watcher. Returns a
 * NO-OP session (nothing recorded) when the profiling watcher is not enabled, so
 * this is safe to leave in code unconditionally.
 *
 * @example
 *   import { startProfile } from '@adonis-agora/telescope/watchers'
 *   const span = startProfile('checkout')
 *   // ... work ...
 *   span.mark('validated')
 *   // ... more work ...
 *   span.end()
 */
export function startProfile(label: string): ProfileSession {
  const watcher = getDefaultProfilingWatcher();
  return watcher ? watcher.startProfile(label) : NOOP_SESSION;
}

/**
 * Time `fn` as a profiling span through the provider-published default watcher.
 * A no-op passthrough (just runs `fn`) when the profiling watcher is not enabled.
 *
 * @example
 *   import { profile } from '@adonis-agora/telescope/watchers'
 *   const order = await profile('checkout', async (span) => {
 *     const cart = await loadCart()
 *     span.mark('cart-loaded')
 *     return placeOrder(cart)
 *   })
 */
export function profile<T>(label: string, fn: (session: ProfileSession) => T): T {
  const watcher = getDefaultProfilingWatcher();
  if (watcher) return watcher.profile(label, fn);
  return fn(NOOP_SESSION);
}
