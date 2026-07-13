import { describe, expect, it } from 'vitest';
import {
  userIdentityTag,
  validateClientErrorBody,
} from '../../src/client_errors/validation.js';

describe('validateClientErrorBody', () => {
  it('accepts a minimal valid report', () => {
    const result = validateClientErrorBody({ message: 'boom' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toBe('boom');
      expect(result.value.name).toBeNull();
      expect(result.value.extra).toBeNull();
    }
  });

  it('accepts a full valid report', () => {
    const result = validateClientErrorBody({
      message: 'TypeError',
      name: 'TypeError',
      stack: 'TypeError: x\n  at f (a.js:1:1)',
      componentStack: 'in App',
      url: 'https://app/page',
      userAgent: 'Mozilla',
      user: { id: 42 },
      release: 'v1.2.3',
      extra: { route: '/x' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('TypeError');
      expect(result.value.extra).toEqual({ route: '/x' });
    }
  });

  it('rejects a non-object body', () => {
    expect(validateClientErrorBody('nope')).toMatchObject({ ok: false });
    expect(validateClientErrorBody(null)).toMatchObject({ ok: false });
    expect(validateClientErrorBody([1, 2])).toMatchObject({ ok: false });
  });

  it('requires a non-empty message', () => {
    expect(validateClientErrorBody({})).toMatchObject({ ok: false });
    expect(validateClientErrorBody({ message: '' })).toMatchObject({ ok: false });
    expect(validateClientErrorBody({ message: 123 })).toMatchObject({ ok: false });
  });

  it('rejects a non-string optional field without coercion', () => {
    expect(validateClientErrorBody({ message: 'm', name: 5 })).toMatchObject({ ok: false });
    expect(validateClientErrorBody({ message: 'm', url: {} })).toMatchObject({ ok: false });
  });

  it('rejects a non-object extra', () => {
    expect(validateClientErrorBody({ message: 'm', extra: 'x' })).toMatchObject({ ok: false });
    expect(validateClientErrorBody({ message: 'm', extra: [1] })).toMatchObject({ ok: false });
  });

  it('length-caps oversized strings rather than rejecting', () => {
    const bigMessage = 'a'.repeat(5000);
    const bigStack = 'b'.repeat(50_000);
    const result = validateClientErrorBody({ message: bigMessage, stack: bigStack });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message.length).toBe(2 * 1024);
      expect(result.value.stack?.length).toBe(16 * 1024);
    }
  });
});

describe('userIdentityTag', () => {
  it('prefers id, then _id, then email', () => {
    expect(userIdentityTag({ id: 7 })).toBe('user:7');
    expect(userIdentityTag({ _id: 'abc' })).toBe('user:abc');
    expect(userIdentityTag({ email: 'a@b.c' })).toBe('user:a@b.c');
    expect(userIdentityTag({ _id: 'x', id: 'y' })).toBe('user:y');
  });

  it('returns null for no usable identity', () => {
    expect(userIdentityTag(null)).toBeNull();
    expect(userIdentityTag('nope')).toBeNull();
    expect(userIdentityTag({})).toBeNull();
    expect(userIdentityTag({ id: '' })).toBeNull();
  });
});
