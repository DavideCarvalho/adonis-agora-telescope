import { currentTraceId } from '../context_accessor.js';
import { EntryType, type RecordInput } from '../entry.js';
import { clampRate, keepByTrace } from '../sampling/trace_sampler.js';
import type { EmitterLike, Watcher } from './emitter.js';
import { safeRecord } from './record.js';

/**
 * The `@adonisjs/cache` event names this watcher subscribes to, mapped to the
 * cache operation recorded for each.
 *
 * NOTE: `@adonisjs/cache` is not installed in this repository, so these event
 * names and their payloads could NOT be verified against its types (see this
 * package's README). They follow `@adonisjs/cache`'s documented `cache:*` event
 * convention but should be treated as best-effort. The set is exported so a host
 * can override it if a future version diverges.
 */
export const CACHE_EVENTS: Record<string, CacheOperation> = {
  'cache:hit': 'hit',
  'cache:miss': 'miss',
  'cache:written': 'write',
  'cache:deleted': 'delete',
  'cache:cleared': 'clear',
};

/** The normalized cache operation a recorded entry describes. */
export type CacheOperation = 'hit' | 'miss' | 'write' | 'delete' | 'clear';

/**
 * The structural slice of a `@adonisjs/cache` event payload this watcher reads.
 * Read defensively (every field optional) because the exact shape is owned by
 * `@adonisjs/cache` and could not be verified here.
 */
export interface CacheEventLike {
  key?: string;
  store?: string;
}

/** Construction-time tuning for {@link CacheWatcher} — the resolved `cache` block of
 *  `config/telescope_watchers.ts`. */
export interface CacheWatcherOptions {
  /** Fraction (0..1) of cache HITS recorded, decided per trace. Misses, writes,
   *  deletes and clears are always recorded. Default 1. */
  hitSampleRate?: number;
  /** Store names (case-insensitive) whose operations are not recorded. */
  ignoreStores?: string[];
  /** Keys not recorded: a string matches as a PREFIX, a RegExp is tested as-is. */
  ignoreKeys?: Array<string | RegExp>;
}

/** The recorded body of a `cache` entry. */
export interface CacheEntryContent {
  /** The cache operation observed. */
  operation: CacheOperation;
  /** The cache key, or `null` when the event did not carry one. */
  key: string | null;
  /** The cache store name (e.g. `'redis'`), or `null`. */
  store: string | null;
  /** The active trace id at operation time, or `null`. */
  traceId: string | null;
}

/**
 * Records `@adonisjs/cache` activity as `cache` telescope entries — one per
 * hit/miss/write/delete/clear event — correlated to the active request via the
 * trace id.
 *
 * Recording is fire-and-forget and fully guarded: a telescope failure can never
 * break a cache operation.
 *
 * @remarks
 * The event-name → operation map ({@link CACHE_EVENTS}) is best-effort because
 * `@adonisjs/cache` is not installed in this repo and its event contract could not
 * be verified. Pass a custom map to the constructor to adapt to your version.
 */
export class CacheWatcher implements Watcher {
  readonly type = EntryType.Cache;
  private readonly events: Record<string, CacheOperation>;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly hitSampleRate: number;
  private readonly ignoreStores: Set<string>;
  private readonly ignoreKeys: Array<string | RegExp>;

  constructor(
    events: Record<string, CacheOperation> = CACHE_EVENTS,
    options: CacheWatcherOptions = {},
  ) {
    this.events = events;
    this.hitSampleRate = clampRate(options.hitSampleRate);
    this.ignoreStores = new Set((options.ignoreStores ?? []).map((s) => s.toLowerCase()));
    this.ignoreKeys = options.ignoreKeys ?? [];
  }

  start(emitter: EmitterLike): void {
    if (this.unsubscribes.length > 0) return;
    for (const [eventName, operation] of Object.entries(this.events)) {
      this.unsubscribes.push(emitter.on(eventName, (data) => this.handle(operation, data)));
    }
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private handle(operation: CacheOperation, data: unknown): void {
    const event: CacheEventLike = data && typeof data === 'object' ? (data as CacheEventLike) : {};
    if (!this.keeps(operation, event)) return;
    safeRecord(() => buildCacheEntry(operation, event), 'CacheWatcher');
  }

  /** Ignored stores and keys first, then hit sampling (so a dropped event burns no entropy). */
  private keeps(operation: CacheOperation, event: CacheEventLike): boolean {
    if (this.ignoreStores.size > 0 && typeof event.store === 'string') {
      if (this.ignoreStores.has(event.store.toLowerCase())) return false;
    }
    if (this.ignoreKeys.length > 0 && typeof event.key === 'string') {
      const key = event.key;
      for (const pattern of this.ignoreKeys) {
        if (typeof pattern === 'string') {
          if (key.startsWith(pattern)) return false;
        } else {
          // A /g or /y pattern keeps `lastIndex` between calls; reset it so each test starts fresh.
          pattern.lastIndex = 0;
          if (pattern.test(key)) return false;
        }
      }
    }
    if (operation === 'hit') return keepByTrace(currentTraceId(), this.hitSampleRate);
    return true;
  }
}

/** Map a cache operation + payload to a telescope {@link RecordInput}. */
export function buildCacheEntry(
  operation: CacheOperation,
  event: CacheEventLike,
): RecordInput<CacheEntryContent> {
  const key = typeof event.key === 'string' ? event.key : null;
  const store = typeof event.store === 'string' ? event.store : null;
  const traceId = currentTraceId();
  const content: CacheEntryContent = { operation, key, store, traceId };
  return {
    type: EntryType.Cache,
    familyHash: key ? `${operation}:${key}` : operation,
    content,
    traceId,
    tags: [`cache:${operation}`, ...(store ? [`store:${store}`] : [])],
  };
}
