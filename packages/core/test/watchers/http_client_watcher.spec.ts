import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { PulseService } from '../../src/metrics/pulse.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopePaused, setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  buildHttpClientEntry,
  type HttpClientEntryContent,
  HttpClientWatcher,
  instrumentFetch,
  markInternalFetch,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A clock whose `now()` returns a scripted sequence — durations are deterministic. */
function scriptedClock(values: number[]): { now(): number } {
  let i = 0;
  return { now: () => values[Math.min(i++, values.length - 1)]! };
}

/** A fetch double resolving a `Response` with the given status (+ optional headers). */
function fakeFetch(status: number, headers?: Record<string, string>): typeof fetch {
  return (async () =>
    new Response('ok', { status, ...(headers !== undefined ? { headers } : {}) })) as typeof fetch;
}

describe('HttpClientWatcher', () => {
  afterEach(() => clearStore());

  describe('buildHttpClientEntry', () => {
    it('shapes an entry with method/url/host/status/duration and tags', () => {
      const input = buildHttpClientEntry({
        method: 'GET',
        url: 'https://api.example.com/v1/x',
        host: 'api.example.com',
        statusCode: 200,
        durationMs: 12,
      });
      expect(input.type).toBe(EntryType.HttpClient);
      const content = input.content as HttpClientEntryContent;
      expect(content.method).toBe('GET');
      expect(content.statusCode).toBe(200);
      expect(content.durationMs).toBe(12);
      expect(content.requestBytes).toBeNull();
      expect(content.responseBytes).toBeNull();
      expect(content.error).toBeNull();
      expect(input.familyHash).toBe('GET api.example.com/v1/x');
      expect(input.tags).toContain('http-client');
      expect(input.tags).toContain('host:api.example.com');
    });

    it('tags 5xx and network failures as failed, and slow calls as slow', () => {
      expect(
        buildHttpClientEntry({
          method: 'GET',
          url: 'http://x/',
          host: 'x',
          statusCode: 503,
          durationMs: 1,
        }).tags,
      ).toContain('failed');
      expect(
        buildHttpClientEntry({
          method: 'GET',
          url: 'http://x/',
          host: 'x',
          statusCode: null,
          durationMs: 1,
        }).tags,
      ).toContain('failed');
      expect(
        buildHttpClientEntry({
          method: 'GET',
          url: 'http://x/',
          host: 'x',
          statusCode: 200,
          durationMs: 5000,
        }).tags,
      ).toContain('slow');
      // A 4xx is a valid response, not a transport failure.
      expect(
        buildHttpClientEntry({
          method: 'GET',
          url: 'http://x/',
          host: 'x',
          statusCode: 404,
          durationMs: 1,
        }).tags,
      ).not.toContain('failed');
    });
  });

  describe('instrumentFetch (opt-in, no global patching)', () => {
    let store: ReturnType<typeof installStore>;

    beforeEach(() => {
      store = installStore();
    });

    it('does NOT mutate globalThis.fetch — the wrapper is a separate function', () => {
      const original = globalThis.fetch;
      const tracked = new HttpClientWatcher().instrumentFetch(fakeFetch(200));
      expect(globalThis.fetch).toBe(original);
      expect(tracked).not.toBe(globalThis.fetch);
    });

    it('records an entry with method, url, status and duration', async () => {
      const tracked = new HttpClientWatcher({
        clock: scriptedClock([100, 142]),
      }).instrumentFetch(fakeFetch(201));

      const res = await tracked('https://api.example.com/charges/123', { method: 'POST' });
      expect(res.status).toBe(201);
      await flush();

      const entries = await store.list({ type: EntryType.HttpClient });
      expect(entries).toHaveLength(1);
      const content = entries[0]?.content as HttpClientEntryContent;
      expect(content.method).toBe('POST');
      expect(content.url).toBe('https://api.example.com/charges/123');
      expect(content.statusCode).toBe(201);
      expect(content.durationMs).toBe(42);
      expect(entries[0]?.familyHash).toBe('POST api.example.com/charges/:id');
    });

    it('records a network failure (statusCode null, failed, error message) and re-throws', async () => {
      const failing = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      const tracked = new HttpClientWatcher().instrumentFetch(failing);

      await expect(tracked('https://down.example.com/')).rejects.toThrow('ECONNREFUSED');
      await flush();

      const entries = await store.list({ type: EntryType.HttpClient });
      expect(entries).toHaveLength(1);
      const content = entries[0]?.content as HttpClientEntryContent;
      expect(content.statusCode).toBeNull();
      expect(content.error).toBe('ECONNREFUSED');
      expect(entries[0]?.tags).toContain('failed');
    });

    it('skips (does not record) calls to an ignored host, but still performs them', async () => {
      const tracked = new HttpClientWatcher({
        ignoreHosts: ['metrics.internal:9090'],
      }).instrumentFetch(fakeFetch(200));

      const res = await tracked('https://metrics.internal:9090/push');
      expect(res.status).toBe(200); // call still happens
      await flush();
      expect(await store.count()).toBe(0); // but nothing recorded

      // A non-ignored host on the same watcher is still recorded.
      await tracked('https://api.example.com/x');
      await flush();
      expect(await store.count()).toBe(1);
    });

    it('sheds (records nothing) while the runtime is paused', async () => {
      setTelescopePaused(true);
      const tracked = new HttpClientWatcher().instrumentFetch(fakeFetch(200));

      const res = await tracked('https://api.example.com/x');
      expect(res.status).toBe(200); // host call unaffected
      await flush();
      expect(await store.count()).toBe(0);
    });

    it('captures request/response body sizes when captureBodies is on', async () => {
      const tracked = new HttpClientWatcher({ captureBodies: true }).instrumentFetch(
        fakeFetch(200, { 'content-length': '128' }),
      );

      await tracked('https://api.example.com/x', { method: 'POST', body: 'hello' });
      await flush();

      const entries = await store.list({ type: EntryType.HttpClient });
      const content = entries[0]?.content as HttpClientEntryContent;
      expect(content.requestBytes).toBe(5);
      expect(content.responseBytes).toBe(128);
    });

    it('skips telescope-internal fetches (recursion guard)', async () => {
      const tracked = new HttpClientWatcher().instrumentFetch(fakeFetch(200));
      await tracked('https://internal.example.com/', markInternalFetch({ method: 'GET' }));
      await flush();
      expect(await store.count()).toBe(0);
    });

    it("standalone instrumentFetch inherits a started watcher's config", async () => {
      const watcher = new HttpClientWatcher({ ignoreHosts: ['skip.me'] });
      watcher.start(); // publishes the default backing a bare instrumentFetch
      try {
        const tracked = instrumentFetch(fakeFetch(200));
        await tracked('https://skip.me/x');
        await flush();
        expect(await store.count()).toBe(0);
      } finally {
        watcher.stop();
      }
    });
  });

  describe('record (manual helper for non-fetch clients)', () => {
    it('records an outbound call described by the caller', async () => {
      const store = installStore();
      new HttpClientWatcher().record({
        method: 'GET',
        url: 'https://api.stripe.com/v1/charges/123456',
        host: 'api.stripe.com',
        statusCode: 200,
        durationMs: 33,
      });
      await flush();

      const entries = await store.list({ type: EntryType.HttpClient });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.familyHash).toBe('GET api.stripe.com/v1/charges/:id');
    });
  });

  it('feeds the Pulse slowOutgoing card', async () => {
    const store = installStore();
    // One slow outbound call (1500ms >= the 1000ms slow-route threshold).
    const tracked = new HttpClientWatcher({
      clock: scriptedClock([0, 1500]),
    }).instrumentFetch(fakeFetch(200));
    await tracked('https://api.example.com/v1/charges/123');
    await flush();

    const summary = await new PulseService(store).getHealth();
    expect(summary.slowOutgoing).toHaveLength(1);
    expect(summary.slowOutgoing[0]?.route).toBe('GET api.example.com/v1/charges/:id');
    expect(summary.slowOutgoing[0]?.p99).toBeGreaterThanOrEqual(1000);
    expect(summary.counts[EntryType.HttpClient]).toBe(1);
  });

  it('redacts a sensitive query-param value in the stored entry', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    const tracked = new HttpClientWatcher().instrumentFetch(fakeFetch(200));

    await tracked('https://api.example.com/v1/charge?token=supersecret&id=1');
    await flush();

    const entries = await inner.list({ type: EntryType.HttpClient });
    expect(entries).toHaveLength(1);
    const content = entries[0]?.content as HttpClientEntryContent;
    expect(content.url).not.toContain('supersecret');
    expect(content.url).toContain('token=%5BREDACTED%5D');
  });
});
