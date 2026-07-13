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

  it('defaults the query watcher config (redact bindings, normalize, 500ms slow)', () => {
    const { query } = resolveConfig();
    expect(query.slowMs).toBe(500);
    expect(query.captureBindings).toBe(false);
    expect(query.ignoreConnections).toEqual([]);
    expect(query.normalize).toBe(true);
  });

  it('honours an explicit query watcher config', () => {
    const { query } = resolveConfig({
      query: {
        slowMs: 50,
        captureBindings: true,
        ignoreConnections: ['replica'],
        normalize: false,
      },
    });
    expect(query.slowMs).toBe(50);
    expect(query.captureBindings).toBe(true);
    expect(query.ignoreConnections).toEqual(['replica']);
    expect(query.normalize).toBe(false);
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
