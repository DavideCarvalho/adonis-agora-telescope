import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { RedactingTelescopeStore } from '../../src/redaction/redacting_store.js';
import { setTelescopeRuntime } from '../../src/registry.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import {
  type HttpClientEntryContent,
  HttpClientWatcher,
  buildHttpClientEntry,
  markInternalFetch,
} from '../../src/watchers/index.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A clock whose `now()` returns a scripted sequence — durations are deterministic. */
function scriptedClock(values: number[]): { now(): number } {
  let i = 0;
  return { now: () => values[Math.min(i++, values.length - 1)] };
}

describe('HttpClientWatcher', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearStore();
  });

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

  describe('patched fetch', () => {
    let store: ReturnType<typeof installStore>;

    beforeEach(() => {
      store = installStore();
    });

    it('records an entry with method, url, status and duration', async () => {
      globalThis.fetch = (async () => new Response('ok', { status: 201 })) as typeof fetch;
      const watcher = new HttpClientWatcher({ clock: scriptedClock([100, 142]) });
      watcher.start();

      const res = await globalThis.fetch('https://api.example.com/charges/123', { method: 'POST' });
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

    it('records a network failure with statusCode null and re-throws', async () => {
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      const watcher = new HttpClientWatcher();
      watcher.start();

      await expect(globalThis.fetch('https://down.example.com/')).rejects.toThrow('ECONNREFUSED');
      await flush();

      const entries = await store.list({ type: EntryType.HttpClient });
      expect(entries).toHaveLength(1);
      expect((entries[0]?.content as HttpClientEntryContent).statusCode).toBeNull();
      expect(entries[0]?.tags).toContain('failed');
    });

    it('restores the original fetch on stop()', async () => {
      const fake = (async () => new Response('ok')) as typeof fetch;
      globalThis.fetch = fake;
      const watcher = new HttpClientWatcher();
      watcher.start();
      expect(globalThis.fetch).not.toBe(fake);

      watcher.stop();
      expect(globalThis.fetch).toBe(fake);

      await globalThis.fetch('https://api.example.com/');
      await flush();
      expect(await store.count()).toBe(0);
    });

    it('skips telescope-internal fetches (recursion guard)', async () => {
      globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
      const watcher = new HttpClientWatcher();
      watcher.start();

      await globalThis.fetch('https://internal.example.com/', markInternalFetch({ method: 'GET' }));
      await flush();
      expect(await store.count()).toBe(0);
    });
  });

  it('redacts a sensitive query-param value in the stored entry', async () => {
    const inner = new InMemoryTelescopeStore({ maxEntries: 100 });
    setTelescopeRuntime(new RedactingTelescopeStore(inner), true);
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    const watcher = new HttpClientWatcher();
    watcher.start();

    await globalThis.fetch('https://api.example.com/v1/charge?token=supersecret&id=1');
    await flush();

    const entries = await inner.list({ type: EntryType.HttpClient });
    expect(entries).toHaveLength(1);
    const content = entries[0]?.content as HttpClientEntryContent;
    expect(content.url).not.toContain('supersecret');
    expect(content.url).toContain('token=%5BREDACTED%5D');
  });
});
