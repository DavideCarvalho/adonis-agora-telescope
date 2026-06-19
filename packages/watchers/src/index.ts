/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// — shared watcher contract —
export type { EmitterLike, Watcher } from './emitter.js';

// — runtime recording (advanced) —
export { resolveStore, safeRecord } from './record.js';

// — Lucid query watcher (the headline watcher) —
export { buildQueryEntry, DB_QUERY_EVENT, LucidQueryWatcher } from './lucid_query_watcher.js';
export type { DbQueryEventLike, QueryEntryContent } from './lucid_query_watcher.js';
export { queryFamilyHash } from './query_family_hash.js';

// — mail watcher —
export { buildMailEntry, MAIL_SENT_EVENT, MailWatcher } from './mail_watcher.js';
export type { MailEntryContent, MailSentEventLike } from './mail_watcher.js';

// — cache watcher —
export { buildCacheEntry, CACHE_EVENTS, CacheWatcher } from './cache_watcher.js';
export type { CacheEntryContent, CacheEventLike, CacheOperation } from './cache_watcher.js';

// — config —
export {
  DEFAULT_WATCHERS,
  defineConfig,
  resolveConfig,
} from './define_config.js';
export type {
  ResolvedTelescopeWatchersConfig,
  TelescopeWatchersConfig,
  WatcherName,
} from './define_config.js';
