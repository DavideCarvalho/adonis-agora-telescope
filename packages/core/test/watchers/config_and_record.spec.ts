import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHERS,
  resolveConfig,
  resolveStore,
  safeRecord,
} from '../../src/watchers/index.js';
import { clearStore, installStore } from './helpers.js';

describe('resolveConfig', () => {
  it('defaults to enabled with only the query watcher', () => {
    const config = resolveConfig();
    expect(config.enabled).toBe(true);
    expect([...config.watchers]).toEqual(DEFAULT_WATCHERS);
    expect(config.watchers.has('query')).toBe(true);
    expect(config.watchers.has('mail')).toBe(false);
  });

  it('honours an explicit watcher list and disabled flag', () => {
    const config = resolveConfig({ enabled: false, watchers: ['query', 'mail', 'cache'] });
    expect(config.enabled).toBe(false);
    expect([...config.watchers].sort()).toEqual(['cache', 'mail', 'query']);
  });
});

describe('safeRecord', () => {
  afterEach(() => clearStore());

  it('is a no-op when no store is installed', () => {
    expect(resolveStore()).toBeNull();
    expect(() => safeRecord({ type: 'query', content: {} }, 'test')).not.toThrow();
  });

  it('records into the installed runtime store', async () => {
    const store = installStore();
    safeRecord({ type: 'query', content: { sql: 'select 1' } }, 'test');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await store.count()).toBe(1);
  });
});
