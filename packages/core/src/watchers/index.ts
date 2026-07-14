/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.5.1';

// — shared watcher contract —
export type { EmitterLike, Watcher } from './emitter.js';

// — runtime recording (advanced) —
export { resolveStore, safeRecord } from './record.js';

// — Lucid query watcher (the headline watcher) —
export { buildQueryEntry, DB_QUERY_EVENT, LucidQueryWatcher } from './lucid_query_watcher.js';
export type {
  DbQueryEventLike,
  LucidQueryWatcherOptions,
  QueryEntryContent,
} from './lucid_query_watcher.js';
export { queryFamilyHash } from './query_family_hash.js';

// — mail watcher —
export { buildMailEntry, MAIL_SENT_EVENT, MailWatcher } from './mail_watcher.js';
export type { MailEntryContent, MailSentEventLike } from './mail_watcher.js';

// — cache watcher —
export { buildCacheEntry, CACHE_EVENTS, CacheWatcher } from './cache_watcher.js';
export type { CacheEntryContent, CacheEventLike, CacheOperation } from './cache_watcher.js';

// — http-client (outbound) watcher —
export {
  buildHttpClientEntry,
  HttpClientWatcher,
  instrumentFetch,
  markInternalFetch,
} from './http_client_watcher.js';
export type {
  HttpClientEntryContent,
  HttpClientWatcherOptions,
  OutgoingCall,
} from './http_client_watcher.js';
export { normalizeHttpTarget } from './normalize_http_target.js';

// — logs watcher —
export { buildLogEntry, extractLog, LOG_LEVELS, LogsWatcher } from './logs_watcher.js';
export type {
  LogEntryContent,
  LoggerLike,
  LogLevel,
  LogsWatcherOptions,
} from './logs_watcher.js';

// — queue/jobs watcher (optional peer: @adonisjs/queue) —
export { buildJobEntry, QUEUE_EXECUTE_CHANNEL, QueueWatcher } from './queue_watcher.js';
export type {
  AcquiredJobLike,
  JobEntryContent,
  JobExecuteMessageLike,
  JobStatus,
  QueueWatcherOptions,
} from './queue_watcher.js';

// — events watcher (core @adonisjs/core Emitter) —
export {
  buildEventEntry,
  DEFAULT_IGNORED_EVENTS,
  EventsWatcher,
  hasOnAny,
} from './events_watcher.js';
export type { EmitterAnyLike, EventEntryContent } from './events_watcher.js';

// — redis watcher (optional peer: @adonisjs/redis) —
export { buildRedisEntry, RedisWatcher } from './redis_watcher.js';
export type {
  RedisClientLike,
  RedisCommandLike,
  RedisConnectionLike,
  RedisEntryContent,
  RedisManagerLike,
} from './redis_watcher.js';

// — profiling watcher (user-driven timing spans; opt-in helpers) —
export {
  buildProfileEntry,
  PROFILE_ENTRY_TYPE,
  profile,
  ProfilingWatcher,
  startProfile,
} from './profiling_watcher.js';
export type {
  CompletedProfile,
  ProfileEntryContent,
  ProfileMark,
  ProfileSession,
  ProfileStatus,
  ProfilingWatcherOptions,
} from './profiling_watcher.js';

// — schedule watcher (scheduled-task runs; explicit wrapper integration) —
export {
  buildScheduleEntry,
  recordScheduledRun,
  SCHEDULED_TASK_ENTRY_TYPE,
  ScheduleWatcher,
  scheduleTask,
} from './schedule_watcher.js';
export type {
  ScheduleEntryContent,
  ScheduledRun,
  ScheduledTaskOptions,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleWatcherOptions,
} from './schedule_watcher.js';

// — config —
export {
  DEFAULT_WATCHERS,
  defineConfig,
  resolveConfig,
} from './define_config.js';
export type {
  HttpClientWatcherConfig,
  ProfilingWatcherConfig,
  QueryWatcherConfig,
  ResolvedHttpClientWatcherConfig,
  ResolvedProfilingWatcherConfig,
  ResolvedQueryWatcherConfig,
  ResolvedScheduleWatcherConfig,
  ResolvedTelescopeWatchersConfig,
  ScheduleWatcherConfig,
  TelescopeWatchersConfig,
  WatcherName,
} from './define_config.js';
