import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationService } from '@adonisjs/core/types';
import { storage } from '../src/stores/factory.js';
import { type TestHarness, makeHarness } from './lucid_helpers.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * Regression for the boot-timing crash: the lucid factory MUST resolve the
 * `Database` from the container (`lucid.db`, aliased in lucid's REGISTER phase, so
 * it is available at the telescope provider's `boot()`), NOT from
 * `@adonisjs/lucid/services/db`. That façade populates its default export only
 * inside `await app.booted(...)` — which runs AFTER every provider's `boot()` — so
 * at the moment the provider builds the store it is still `undefined` and throws
 * "Cannot read properties of undefined (reading 'connection')".
 */
describe('storage.lucid factory', () => {
  it('resolves lucid.db from the container and builds a working store', async () => {
    const make = vi.fn(async (key: string) => {
      if (key === 'lucid.db') return harness.db;
      throw new Error(`unexpected container key: ${key}`);
    });
    const app = { container: { make } } as unknown as ApplicationService;

    const store = await storage.lucid({ autoCreateTable: true })({ app });

    // The fix: db is resolved via the container, never the booted-gated façade.
    expect(make).toHaveBeenCalledWith('lucid.db');

    const entry = await store.record({ type: 'diagnostic', content: { ok: true } });
    const fetched = await store.get(entry.id);
    expect(fetched?.type).toBe('diagnostic');
  });

  it('binds the named connection client when `connection` is set', async () => {
    const connection = vi.fn((name: string) => harness.db.connection(name));
    const make = vi.fn(async () => ({ connection }));
    const app = { container: { make } } as unknown as ApplicationService;

    const store = await storage.lucid({ connection: 'primary', autoCreateTable: true })({ app });

    expect(make).toHaveBeenCalledWith('lucid.db');
    expect(connection).toHaveBeenCalledWith('primary');

    const entry = await store.record({ type: 'x', content: 1 });
    expect(await store.get(entry.id)).not.toBeNull();
  });
});
