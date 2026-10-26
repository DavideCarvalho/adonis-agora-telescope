import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../src/registry.js';
import type { HttpContextLike } from '../src/request_watcher.js';
import type { TelescopeStore } from '../src/store.js';
import TelescopeMiddleware from '../src/telescope_middleware.js';

function stubCtx(): HttpContextLike {
  return {
    request: { method: () => 'GET', url: () => '/orders' },
    response: { statusCode: 200 },
  };
}

function storeWith(record: TelescopeStore['record']): TelescopeStore {
  return {
    record,
    get: async () => null,
    list: async () => [],
    count: async () => 0,
    prune: async () => 0,
    clear: async () => {},
  };
}

const TIMED_OUT = Symbol('timed out');
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);

describe('TelescopeMiddleware recording', () => {
  afterEach(() => {
    resetTelescopeRuntime();
    vi.restoreAllMocks();
  });

  it('does not hold the response while the store is writing', async () => {
    const record = vi.fn(() => new Promise<never>(() => {}));
    setTelescopeRuntime(storeWith(record), true);

    const handled = new TelescopeMiddleware().handle(stubCtx() as never, async () => 'body');

    expect(await within(handled, 200)).toBe('body');
    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0] as unknown[])[0]).toMatchObject({
      type: 'request',
      content: { url: '/orders' },
    });
  });

  it('does not hold a failing request while the exception is written', async () => {
    const record = vi.fn(() => new Promise<never>(() => {}));
    setTelescopeRuntime(storeWith(record), true);
    const boom = new Error('boom');

    const handled = new TelescopeMiddleware().handle(stubCtx() as never, async () => {
      throw boom;
    });

    expect(
      await within(
        handled.catch((error: unknown) => error),
        200,
      ),
    ).toBe(boom);
    expect(
      record.mock.calls.map((call) => (call as unknown as [{ type: string }])[0].type),
    ).toEqual(['exception', 'request']);
  });

  it('reports a failed recording instead of swallowing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTelescopeRuntime(
      storeWith(() => Promise.reject(new Error('database is down'))),
      true,
    );

    await new TelescopeMiddleware().handle(stubCtx() as never, async () => {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledWith(expect.stringContaining('database is down'));
  });
});
