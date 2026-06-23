import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { EntryEvents } from '../../src/stream/entry_events.js';
import { DEFAULT_HEARTBEAT_MS, streamEntries } from '../../src/stream/stream_handler.js';
import { toSummary } from '../../src/ui/api.js';
import { RecordingSink } from '../../src/ui/http.js';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    type: 'request',
    familyHash: 'GET /users',
    content: { method: 'GET', url: '/users', status: 200 },
    tags: ['method:GET'],
    sequence: 1,
    durationMs: 12,
    origin: 'http',
    traceId: 'trace-a',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

/** A deterministic timer: captures the registered callback so a test fires it by hand. */
function fakeTimer() {
  let registered: (() => void) | null = null;
  let cleared = false;
  return {
    timer: {
      setInterval: (fn: () => void) => {
        registered = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    },
    tick: () => registered?.(),
    get cleared() {
      return cleared;
    },
    get hasInterval() {
      return registered !== null;
    },
  };
}

describe('streamEntries', () => {
  it('writes an SSE handshake comment on connect', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    streamEntries(events, sink, { heartbeatMs: 0 });
    expect(sink.chunks[0]).toBe(': connected\n\n');
  });

  it('formats each published entry as a `data:` frame with an `entry` event name', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    streamEntries(events, sink, { heartbeatMs: 0 });

    const e = entry();
    events.publish(e);

    const frame = sink.chunks.at(-1) as string;
    expect(frame.startsWith('event: entry\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);

    const dataLine = frame.split('\n').find((l) => l.startsWith('data: ')) as string;
    const payload = JSON.parse(dataLine.slice('data: '.length));
    // Streams the already-redacted list summary shape, not the raw entry.
    expect(payload).toEqual(toSummary(e));
  });

  it('streams multiple entries in order', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    streamEntries(events, sink, { heartbeatMs: 0 });

    events.publish(entry({ id: 'a' }));
    events.publish(entry({ id: 'b' }));

    const ids = sink.chunks
      .filter((c) => c.startsWith('event: entry\n'))
      .map((c) => {
        const dataLine = c.split('\n').find((l) => l.startsWith('data: ')) as string;
        return JSON.parse(dataLine.slice('data: '.length)).id;
      });
    expect(ids).toEqual(['a', 'b']);
  });

  it('emits a comment-only heartbeat on the timer tick', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    const clock = fakeTimer();
    streamEntries(events, sink, { heartbeatMs: 1000, timer: clock.timer });

    expect(clock.hasInterval).toBe(true);
    clock.tick();
    expect(sink.chunks.at(-1)).toBe(': heartbeat\n\n');
  });

  it('does not register a heartbeat when heartbeatMs is 0', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    const clock = fakeTimer();
    streamEntries(events, sink, { heartbeatMs: 0, timer: clock.timer });
    expect(clock.hasInterval).toBe(false);
  });

  it('unsubscribes and clears the heartbeat on client disconnect', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    const clock = fakeTimer();
    streamEntries(events, sink, { heartbeatMs: 1000, timer: clock.timer });

    expect(events.subscriberCount).toBe(1);
    sink.close(); // simulate client disconnect

    expect(events.subscriberCount).toBe(0);
    expect(clock.cleared).toBe(true);

    // Further publishes must not reach the (now-closed) sink.
    const before = sink.chunks.length;
    events.publish(entry());
    expect(sink.chunks.length).toBe(before);
  });

  it('session.close() tears down explicitly and is idempotent', () => {
    const events = new EntryEvents();
    const sink = new RecordingSink();
    const session = streamEntries(events, sink, { heartbeatMs: 0 });

    expect(events.subscriberCount).toBe(1);
    session.close();
    session.close(); // idempotent
    expect(events.subscriberCount).toBe(0);
  });

  it('defaults the heartbeat interval to 15s', () => {
    expect(DEFAULT_HEARTBEAT_MS).toBe(15_000);
  });
});
