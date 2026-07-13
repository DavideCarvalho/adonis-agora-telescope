import { describe, expect, it } from 'vitest';
import { ClientErrorRateLimiter } from '../../src/client_errors/rate_limiter.js';

describe('ClientErrorRateLimiter', () => {
  it('allows up to perMinute requests then blocks', () => {
    let now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 3, now: () => now });
    expect(limiter.tryConsume('1.1.1.1')).toBe(true);
    expect(limiter.tryConsume('1.1.1.1')).toBe(true);
    expect(limiter.tryConsume('1.1.1.1')).toBe(true);
    // Bucket empty -> over the limit.
    expect(limiter.tryConsume('1.1.1.1')).toBe(false);
  });

  it('tracks buckets per IP independently', () => {
    let now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 1, now: () => now });
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    // A different IP has its own full bucket.
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('refills continuously over elapsed time', () => {
    let now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 60, now: () => now });
    expect(limiter.tryConsume('ip')).toBe(true); // 59 left
    // Drain the rest.
    for (let i = 0; i < 59; i++) limiter.tryConsume('ip');
    expect(limiter.tryConsume('ip')).toBe(false);
    // 60/min == 1/sec: advance 1s -> exactly one token back.
    now += 1000;
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('treats a non-positive rate as 1/min rather than locking out forever', () => {
    let now = 0;
    const limiter = new ClientErrorRateLimiter({ perMinute: 0, now: () => now });
    expect(limiter.tryConsume('ip')).toBe(true);
    expect(limiter.tryConsume('ip')).toBe(false);
  });

  it('bounds the tracked-IP map by evicting the oldest', () => {
    const limiter = new ClientErrorRateLimiter({ perMinute: 10, maxTrackedIps: 2 });
    limiter.tryConsume('a');
    limiter.tryConsume('b');
    expect(limiter.size).toBe(2);
    limiter.tryConsume('c'); // evicts 'a'
    expect(limiter.size).toBe(2);
    // 'a' was evicted -> fresh full bucket on next hit.
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.size).toBe(2); // evicts 'b'
  });
});
