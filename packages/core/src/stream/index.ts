// — entry-events pub/sub (SSE live-stream) —

export type { EntrySubscriber, Unsubscribe } from './entry_events.js';
export { EntryEvents } from './entry_events.js';
export type { StreamOptions, StreamSession } from './stream_handler.js';
export {
  DEFAULT_HEARTBEAT_MS,
  streamEntries,
} from './stream_handler.js';
export { StreamingTelescopeStore } from './streaming_store.js';
