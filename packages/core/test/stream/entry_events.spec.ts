import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/entry.js';
import { EntryEvents } from '../../src/stream/entry_events.js';

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    type: 'request',
    familyHash: null,
    content: { method: 'GET', url: '/' },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    traceId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('EntryEvents', () => {
  it('delivers published entries to a subscriber', () => {
    const events = new EntryEvents();
    const received: Entry[] = [];
    events.subscribe((e) => received.push(e));

    const a = entry({ id: 'a' });
    const b = entry({ id: 'b', type: 'diagnostic' });
    events.publish(a);
    events.publish(b);

    expect(received).toEqual([a, b]);
  });

  it('fans out to every subscriber', () => {
    const events = new EntryEvents();
    const one: Entry[] = [];
    const two: Entry[] = [];
    events.subscribe((e) => one.push(e));
    events.subscribe((e) => two.push(e));

    const e = entry();
    events.publish(e);

    expect(one).toEqual([e]);
    expect(two).toEqual([e]);
  });

  it('stops delivery after unsubscribe', () => {
    const events = new EntryEvents();
    const received: Entry[] = [];
    const unsubscribe = events.subscribe((e) => received.push(e));

    events.publish(entry({ id: 'a' }));
    unsubscribe();
    events.publish(entry({ id: 'b' }));

    expect(received.map((e) => e.id)).toEqual(['a']);
  });

  it('unsubscribe is idempotent and only drops its own subscriber', () => {
    const events = new EntryEvents();
    const kept: Entry[] = [];
    const dropped: Entry[] = [];
    const unsubKept = events.subscribe((e) => kept.push(e));
    const unsubDropped = events.subscribe((e) => dropped.push(e));

    unsubDropped();
    unsubDropped(); // idempotent: no throw, no effect on the other subscriber
    events.publish(entry());

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    unsubKept();
  });

  it('is a no-op (subscriberCount 0) when nobody is listening', () => {
    const events = new EntryEvents();
    expect(events.subscriberCount).toBe(0);
    // Must not throw with no subscribers.
    expect(() => events.publish(entry())).not.toThrow();
  });

  it('tracks subscriberCount', () => {
    const events = new EntryEvents();
    expect(events.subscriberCount).toBe(0);
    const unsub = events.subscribe(() => {});
    expect(events.subscriberCount).toBe(1);
    events.subscribe(() => {});
    expect(events.subscriberCount).toBe(2);
    unsub();
    expect(events.subscriberCount).toBe(1);
  });

  it('isolates a throwing subscriber so others still receive (never breaks the flush)', () => {
    const events = new EntryEvents();
    const received: string[] = [];
    events.subscribe(() => {
      throw new Error('boom');
    });
    events.subscribe((e) => received.push(e.id));

    expect(() => events.publish(entry({ id: 'a' }))).not.toThrow();
    expect(received).toEqual(['a']);
  });

  it('clear() drops every subscriber', () => {
    const events = new EntryEvents();
    const received: Entry[] = [];
    events.subscribe((e) => received.push(e));
    events.clear();
    events.publish(entry());
    expect(received).toHaveLength(0);
    expect(events.subscriberCount).toBe(0);
  });
});
