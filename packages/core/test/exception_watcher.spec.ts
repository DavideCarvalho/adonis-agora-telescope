import { afterEach, describe, expect, it } from 'vitest';
import { EntryType } from '../src/entry.js';
import { exceptionFamilyHash } from '../src/exception_family_hash.js';
import {
  type ExceptionEntryContent,
  buildExceptionInput,
  recordException,
  recordExceptionInStore,
} from '../src/exception_watcher.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../src/registry.js';

describe('exceptionFamilyHash', () => {
  it('groups identical errors thrown from the same site', () => {
    const stack = 'TypeError: x is undefined\n    at foo (/app/a.ts:10:5)';
    const a = exceptionFamilyHash({ name: 'TypeError', message: 'x is undefined', stack });
    const b = exceptionFamilyHash({ name: 'TypeError', message: 'x is undefined', stack });
    expect(a).toBe(b);
  });

  it('separates the same message thrown from different sites', () => {
    const a = exceptionFamilyHash({
      name: 'TypeError',
      message: 'x is undefined',
      stack: 'TypeError: x is undefined\n    at foo (/app/a.ts:10:5)',
    });
    const b = exceptionFamilyHash({
      name: 'TypeError',
      message: 'x is undefined',
      stack: 'TypeError: x is undefined\n    at bar (/app/b.ts:20:5)',
    });
    expect(a).not.toBe(b);
  });

  it('degrades to name+message when no stack frame is present', () => {
    expect(exceptionFamilyHash({ name: 'Error', message: 'boom', stack: null })).toBe(
      'Error:boom:',
    );
  });
});

describe('buildExceptionInput', () => {
  it('captures name, message, stack and a family hash', () => {
    const error = new TypeError('nope');
    const input = buildExceptionInput(error);
    const content = input.content;
    expect(input.type).toBe(EntryType.Exception);
    expect(content.name).toBe('TypeError');
    expect(content.message).toBe('nope');
    expect(content.stack).toContain('TypeError');
    expect(input.familyHash).toBe(
      exceptionFamilyHash({ name: 'TypeError', message: 'nope', stack: content.stack }),
    );
    expect(input.tags).toContain('exception:TypeError');
  });

  it('records request method/url and strips the query string', () => {
    const input = buildExceptionInput(new Error('x'), {
      method: 'post',
      url: '/users/42?token=secret',
    });
    expect(input.content.method).toBe('POST');
    expect(input.content.url).toBe('/users/42');
    expect(input.tags).toContain('method:POST');
  });

  it('handles non-Error throws', () => {
    const input = buildExceptionInput('a string failure');
    expect(input.content.name).toBe('Error');
    expect(input.content.message).toBe('a string failure');
    expect(input.content.stack).toBeNull();
  });
});

describe('recordExceptionInStore', () => {
  it('records an exception entry and backfills the trace id', async () => {
    const store = new InMemoryTelescopeStore();
    await recordExceptionInStore(store, new Error('kaboom'), { traceId: 'tr-1' });
    const entries = await store.list({ type: EntryType.Exception });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    const content = entry?.content as ExceptionEntryContent;
    expect(content.message).toBe('kaboom');
    expect(entry?.traceId).toBe('tr-1');
    expect(content.traceId).toBe('tr-1');
  });

  it('groups two identical errors under the same family hash', async () => {
    const store = new InMemoryTelescopeStore();
    function failing() {
      throw new RangeError('out of range');
    }
    const errors: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        failing();
      } catch (e) {
        errors.push(e);
      }
    }
    for (const e of errors) await recordExceptionInStore(store, e);
    const entries = await store.list({ type: EntryType.Exception });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.familyHash).toBe(entries[1]?.familyHash);
  });
});

describe('recordException (standalone)', () => {
  afterEach(() => resetTelescopeRuntime());

  it('records via the global runtime store', async () => {
    const store = new InMemoryTelescopeStore();
    setTelescopeRuntime(store, true);
    const entry = await recordException(new Error('manual'));
    expect(entry).not.toBeNull();
    expect(await store.list({ type: EntryType.Exception })).toHaveLength(1);
  });

  it('is a no-op (returns null) when no store is booted', async () => {
    resetTelescopeRuntime();
    expect(await recordException(new Error('nowhere'))).toBeNull();
  });

  it('never throws when the store fails', async () => {
    const failing = {
      record: () => Promise.reject(new Error('store down')),
    } as unknown as InMemoryTelescopeStore;
    setTelescopeRuntime(failing, true);
    await expect(recordException(new Error('x'))).resolves.toBeNull();
  });
});
