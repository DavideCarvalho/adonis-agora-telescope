import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDiscovery } from '../../src/discovery/config.js';
import { type RunningDiscovery, startDiscovery } from '../../src/discovery/index.js';
import { probeFetchRewrite } from '../../src/discovery/rewrite.js';
import { resolveTopology } from '../../src/topology/config.js';

/**
 * The start-time self-check: `fetch` must really go through the rewrite, on Node 24 (dispatcher
 * slot `.1`) and Node 26 (`.2`). A probe to a reserved `.invalid` origin is answered by the
 * interceptor itself: no network.
 */

const slot = globalThis as unknown as Record<symbol, unknown>;
const KEYS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
let originals: unknown[];
let discovery: RunningDiscovery | null;

beforeAll(async () => {
  await fetch('data:,').catch(() => undefined);
  originals = KEYS.map((key) => slot[key]);
  discovery = await startDiscovery({
    config: resolveDiscovery({ billing: 'http://127.0.0.1:1' }),
    topology: resolveTopology({}),
  });
});

afterAll(async () => {
  KEYS.forEach((key, i) => {
    slot[key] = originals[i];
  });
  await discovery?.stop();
});

describe('discovery self-check', () => {
  it('passes when fetch goes through the rewrite', async () => {
    expect(await probeFetchRewrite()).toBe(true);
    await expect(discovery?.ready()).resolves.toBeUndefined();
  });

  it('fails the start when something replaced the dispatcher with one it cannot compose onto', async () => {
    // A dispatcher swapped in wholesale (not composed): the rewrite is no longer in fetch's path.
    KEYS.forEach((key, i) => {
      const original = originals[i] as { dispatch(o: unknown, h: unknown): boolean } | undefined;
      if (original !== undefined) {
        slot[key] = { dispatch: (o: unknown, h: unknown) => original.dispatch(o, h) };
      }
    });
    expect(await probeFetchRewrite()).toBe(false);
    await expect(discovery?.ready()).rejects.toThrow(/does not go through telescope's rewrite/);
  });
});
