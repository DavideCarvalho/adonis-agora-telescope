import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASK,
  DEFAULT_REDACT_KEYS,
  redact,
  redactBounded,
} from '../../src/redaction/redact.js';

describe('redact', () => {
  it('masks every default sensitive key at the top level', () => {
    const input: Record<string, string> = {};
    for (const key of DEFAULT_REDACT_KEYS) input[key] = 'secret-value';
    input.keep = 'visible';

    const out = redact(input) as Record<string, string>;
    for (const key of DEFAULT_REDACT_KEYS) expect(out[key]).toBe(DEFAULT_MASK);
    expect(out.keep).toBe('visible');
  });

  it('masks nested sensitive keys at any depth', () => {
    const out = redact({
      level1: { level2: { password: 'hunter2', name: 'davi' } },
      headers: { Authorization: 'Bearer abc' },
    }) as Record<string, Record<string, Record<string, string>>>;

    expect(out.level1.level2.password).toBe(DEFAULT_MASK);
    expect(out.level1.level2.name).toBe('davi');
    expect((out.headers as unknown as Record<string, string>).Authorization).toBe(DEFAULT_MASK);
  });

  it('matches sensitive keys case-insensitively', () => {
    const out = redact({
      PASSWORD: 'a',
      Token: 'b',
      'X-API-Key': 'c',
      'Set-Cookie': 'd',
    }) as Record<string, string>;

    expect(out.PASSWORD).toBe(DEFAULT_MASK);
    expect(out.Token).toBe(DEFAULT_MASK);
    expect(out['X-API-Key']).toBe(DEFAULT_MASK);
    expect(out['Set-Cookie']).toBe(DEFAULT_MASK);
  });

  it('masks user-supplied extra keys merged with defaults', () => {
    const out = redact({ ssn: '123', password: 'p', keep: 'ok' }, { keys: ['ssn'] }) as Record<
      string,
      string
    >;
    expect(out.ssn).toBe(DEFAULT_MASK);
    expect(out.password).toBe(DEFAULT_MASK);
    expect(out.keep).toBe('ok');
  });

  it('masks exact dot-paths regardless of key name', () => {
    const out = redact(
      { body: { ssn: '123', other: 'x' }, ssn: 'top' },
      { paths: ['body.ssn'] },
    ) as Record<string, Record<string, string>>;
    expect(out.body.ssn).toBe(DEFAULT_MASK);
    expect(out.body.other).toBe('x');
    // The top-level ssn is NOT a configured path and not a default key.
    expect(out.ssn).toBe('top');
  });

  it('honours a custom mask string', () => {
    const out = redact({ password: 'x' }, { mask: '***' }) as Record<string, string>;
    expect(out.password).toBe('***');
  });

  it('does not mutate the input', () => {
    const input = { password: 'secret', nested: { token: 't' } };
    redact(input);
    expect(input.password).toBe('secret');
    expect(input.nested.token).toBe('t');
  });

  it('clones arrays and masks sensitive keys inside them', () => {
    const out = redact({ users: [{ password: 'a' }, { password: 'b' }] }) as {
      users: Array<Record<string, string>>;
    };
    expect(out.users[0].password).toBe(DEFAULT_MASK);
    expect(out.users[1].password).toBe(DEFAULT_MASK);
  });

  it('passes through primitives untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact('hello')).toBe('hello');
    expect(redact(null)).toBe(null);
    expect(redact(true)).toBe(true);
  });

  describe('bounds', () => {
    it('truncates beyond maxDepth', () => {
      const result = redactBounded({ a: { b: { c: { d: 'deep' } } } }, { maxDepth: 2 });
      const out = result.value as Record<string, Record<string, unknown>>;
      expect(out.a.b).toBe('[Truncated: depth]');
      expect(result.truncated).toBe(true);
    });

    it('clips strings longer than maxStringLength', () => {
      const result = redactBounded({ blob: 'x'.repeat(100) }, { maxStringLength: 10 });
      const out = result.value as Record<string, string>;
      expect(out.blob.startsWith('x'.repeat(10))).toBe(true);
      expect(out.blob).toContain('[truncated]');
      expect(result.truncated).toBe(true);
    });

    it('clips arrays longer than maxArrayLength and appends a marker', () => {
      const result = redactBounded(
        { items: Array.from({ length: 50 }, (_, i) => i) },
        {
          maxArrayLength: 5,
        },
      );
      const out = result.value as { items: unknown[] };
      // 5 kept items + 1 trailing marker.
      expect(out.items).toHaveLength(6);
      expect(out.items[5]).toBe('[Truncated: 5 of 50 items]');
      expect(result.truncated).toBe(true);
    });

    it('prunes once the node budget runs out', () => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
      const result = redactBounded(wide, { maxNodes: 10 });
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result.value)).toContain('[Truncated: size]');
    });

    it('reports truncated=false for a normal small payload', () => {
      const result = redactBounded({ a: 1, b: { c: 'hi' } });
      expect(result.truncated).toBe(false);
      expect(result.value).toEqual({ a: 1, b: { c: 'hi' } });
    });
  });

  describe('cycle safety', () => {
    it('does not throw on a self-referential object', () => {
      const obj: Record<string, unknown> = { name: 'root' };
      obj.self = obj;
      const out = redact(obj) as Record<string, unknown>;
      expect(out.name).toBe('root');
      expect(out.self).toBe('[Circular]');
    });

    it('does not throw on a cyclic array', () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      const out = redact({ arr }) as { arr: unknown[] };
      expect(out.arr[0]).toBe(1);
      expect(out.arr[2]).toBe('[Circular]');
    });

    it('does not treat a non-cyclic shared sibling reference as circular', () => {
      const shared = { token: 'x', label: 'shared' };
      const out = redact({ a: shared, b: shared }) as Record<string, Record<string, string>>;
      // Both siblings are fully cloned + masked; neither becomes [Circular].
      expect(out.a.token).toBe(DEFAULT_MASK);
      expect(out.b.token).toBe(DEFAULT_MASK);
      expect(out.a.label).toBe('shared');
      expect(out.b.label).toBe('shared');
    });
  });
});

describe('redact binary blobs (large Buffer/TypedArray)', () => {
  it('summarizes a multi-MB Buffer as an O(1) marker instead of walking its bytes', () => {
    // A Buffer is `typeof 'object'` and not an Array, so without the binary
    // guard it satisfies isPlainObject() and `Object.entries()` eagerly builds
    // one [index, byte] pair per byte — seconds of sync CPU on an 8 MiB body (a
    // raw file-upload chunk) that stalls the event loop. This asserts the
    // guard: an 8 MiB Buffer clones to a tiny marker, fast and bounded.
    const eightMiB = Buffer.alloc(8 * 1024 * 1024, 1);
    const startedAt = process.hrtime.bigint();
    const result = redactBounded({ body: eightMiB }, {});
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(result.truncated).toBe(true);
    expect((result.value as { body: string }).body).toBe(`[Buffer: ${8 * 1024 * 1024} bytes]`);
    // The whole point is that this is cheap. Object.entries() on 8 MiB would be
    // multi-second; the marker path is sub-millisecond, so a generous ceiling
    // still proves the byte-walk never happened.
    expect(elapsedMs).toBeLessThan(100);
  });

  it('summarizes a Uint8Array with its constructor name and byte length', () => {
    const result = redactBounded({ chunk: new Uint8Array(2048) }, {});
    expect((result.value as { chunk: string }).chunk).toBe('[Uint8Array: 2048 bytes]');
  });

  it('summarizes a raw ArrayBuffer', () => {
    const result = redactBounded({ raw: new ArrayBuffer(4096) }, {});
    expect((result.value as { raw: string }).raw).toBe('[ArrayBuffer: 4096 bytes]');
  });
});
