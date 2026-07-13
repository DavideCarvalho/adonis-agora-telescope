import { describe, expect, it, vi } from 'vitest';
import { TelescopeApiError, TelescopeClient } from './telescope-client.js';

/** A `fetch` stub that records the requested URL and returns `body` wrapped in a JSON Response. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const client = (fetch: typeof globalThis.fetch) =>
  new TelescopeClient({ baseUrl: '/telescope/api', fetch });

describe('TelescopeClient', () => {
  it('lists entries with filters and unwraps the data envelope', async () => {
    const { fetch, calls } = stubFetch({ data: [{ id: 'e1', type: 'request' }], meta: {} });
    const rows = await client(fetch).listEntries({ type: 'request', search: 'users', limit: 25 });
    expect(rows).toEqual([{ id: 'e1', type: 'request' }]);
    expect(calls[0]).toContain('/telescope/api/entries?');
    expect(calls[0]).toContain('type=request');
    expect(calls[0]).toContain('search=users');
    expect(calls[0]).toContain('limit=25');
  });

  it('fetches a single entry by id', async () => {
    const { fetch, calls } = stubFetch({ data: { id: 'e1', type: 'request', content: {} } });
    const entry = await client(fetch).getEntry('e1');
    expect(entry.id).toBe('e1');
    expect(calls[0]).toBe('/telescope/api/entries/e1');
  });

  it('fetches the pulse rollup with a window', async () => {
    const { fetch, calls } = stubFetch({ data: { windowMs: 3600000, counts: {} } });
    await client(fetch).pulse(3_600_000);
    expect(calls[0]).toContain('/telescope/api/metrics/pulse?');
    expect(calls[0]).toContain('windowMs=3600000');
  });

  it('fetches a trace waterfall', async () => {
    const { fetch, calls } = stubFetch({
      data: { traceStartMs: 0, totalDurationMs: 10, spans: [] },
    });
    await client(fetch).waterfall('trace-1');
    expect(calls[0]).toBe('/telescope/api/metrics/waterfall/trace-1');
  });

  it('builds the SSE stream URL', () => {
    const { fetch } = stubFetch({});
    expect(client(fetch).streamUrl()).toBe('/telescope/api/stream');
  });

  it('throws TelescopeApiError with the status on a non-2xx response', async () => {
    const { fetch } = stubFetch({ error: 'nope' }, false, 403);
    await expect(client(fetch).listEntries()).rejects.toMatchObject({
      name: 'TelescopeApiError',
      status: 403,
    });
    await expect(client(fetch).listEntries()).rejects.toBeInstanceOf(TelescopeApiError);
  });
});
