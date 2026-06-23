// — entry-events pub/sub (SSE live-stream) —
export { EntryEvents } from './entry_events.js';
export type { EntrySubscriber, Unsubscribe } from './entry_events.js';
export { StreamingTelescopeStore } from './streaming_store.js';
export {
  DEFAULT_HEARTBEAT_MS,
  streamEntries,
} from './stream_handler.js';
export type { StreamOptions, StreamSession } from './stream_handler.js';
