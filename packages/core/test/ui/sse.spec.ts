import { describe, expect, it } from 'vitest';
import { formatSseFrame, formatSseHeartbeat, RecordingSink } from '../../src/ui/http.js';

describe('formatSseFrame', () => {
  it('JSON-encodes data onto a single data: line, blank-line terminated', () => {
    expect(formatSseFrame({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('prefixes an event name when given', () => {
    expect(formatSseFrame({ id: 'x' }, 'entry')).toBe('event: entry\ndata: {"id":"x"}\n\n');
  });
});

describe('formatSseHeartbeat', () => {
  it('is a comment-only keep-alive frame', () => {
    expect(formatSseHeartbeat()).toBe(': heartbeat\n\n');
  });
});

describe('RecordingSink', () => {
  it('captures written chunks', () => {
    const sink = new RecordingSink();
    sink.write('a');
    sink.write('b');
    expect(sink.chunks).toEqual(['a', 'b']);
  });

  it('fires close handlers once and reports closed', () => {
    const sink = new RecordingSink();
    let calls = 0;
    sink.onClose(() => calls++);
    sink.close();
    sink.close(); // idempotent
    expect(calls).toBe(1);
    expect(sink.closed).toBe(true);
  });
});
