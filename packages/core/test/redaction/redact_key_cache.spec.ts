import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileRedactSpec, redact, redactBoundedWith } from '../../src/redaction/redact.js';

describe('redaction key matching', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lowercases each distinct key once per spec, not once per entry', () => {
    const spec = compileRedactSpec({});
    const content = () => ({ sql: 'select 1', bindings: [1], connection: 'primary', Token: 't' });
    redactBoundedWith(content(), {}, spec);
    const lower = vi.spyOn(String.prototype, 'toLowerCase');

    for (let i = 0; i < 100; i++) {
      expect(redactBoundedWith(content(), {}, spec).value).toEqual({
        sql: 'select 1',
        bindings: [1],
        connection: 'primary',
        Token: '[REDACTED]',
      });
    }

    expect(lower).not.toHaveBeenCalled();
  });

  it('keeps matching case-insensitively for every spelling of a key', () => {
    const options = { keys: ['X-Token'] };
    for (let i = 0; i < 3; i += 1) {
      expect(redact({ 'x-token': 'k', 'X-TOKEN': 'k', keep: i }, options)).toEqual({
        'x-token': '[REDACTED]',
        'X-TOKEN': '[REDACTED]',
        keep: i,
      });
    }
  });

  it('never reads the value of a key it masks', () => {
    const read = vi.fn(() => 'hunter2');
    const content = { user: 'ada' } as Record<string, unknown>;
    Object.defineProperty(content, 'password', { get: read, enumerable: true });

    expect(redact(content)).toEqual({ user: 'ada', password: '[REDACTED]' });
    expect(read).not.toHaveBeenCalled();
  });
});
