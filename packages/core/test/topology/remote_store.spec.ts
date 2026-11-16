import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTelescopeStore } from '../../src/index.js';
import { RemoteTelescopeStore } from '../../src/topology/remote_store.js';

type Call = { url: string; headers: Record<string, string>; body: { entries: unknown[] } };

/** A fake server: answers each call with the next status (the last one repeats). */
function fakeServer(...statuses: Array<number | Error>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const next = statuses.length > 1 ? statuses.shift() : statuses[0];
    if (next instanceof Error) throw next;
    return new Response('{}', { status: next ?? 202 });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const stores: RemoteTelescopeStore[] = [];
function make(
  fetch: typeof globalThis.fetch,
  extra: Partial<ConstructorParameters<typeof RemoteTelescopeStore>[0]> = {},
) {
  let now = 1_000_000;
  const store = new RemoteTelescopeStore({
    url: 'https://telescope.test',
    partition: 'shop',
    token: 'secret',
    fetch,
    now: () => now,
    buffer: { flushIntervalMs: 60_000, retry: { baseMs: 1000, maxMs: 8000 } },
    ...extra,
  });
  stores.push(store);
  return { store, advance: (ms: number) => (now += ms) };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

const log = (message: string) => ({ type: 'log', content: { message }, tags: ['level:info'] });

describe('tenant: remote store', () => {
  it('record() returns at once, never touching the network', async () => {
    const server = fakeServer(202);
    const { store } = make(server.fetch);
    const entry = await store.record(log('hello'));
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.tags).toEqual(['level:info']);
    expect(server.calls).toHaveLength(0);
    expect(store.stats().buffered).toBe(1);
  });

  it('sends batches to <url>/_telescope/v1/ingest with the token and the app name', async () => {
    const server = fakeServer(202);
    const { store } = make(server.fetch, { buffer: { batchSize: 2, flushIntervalMs: 60_000 } });
    for (const m of ['a', 'b', 'c']) await store.record(log(m));
    await store.flush();
    expect(server.calls).toHaveLength(2);
    const [first] = server.calls;
    expect(first?.url).toBe('https://telescope.test/_telescope/v1/ingest');
    expect(first?.headers.authorization).toBe('Bearer secret');
    expect(first?.headers['x-telescope-app']).toBe('shop');
    expect(first?.body.entries).toHaveLength(2);
    expect(first?.body.entries[0]).toMatchObject({ type: 'log', content: { message: 'a' } });
    expect(store.stats()).toMatchObject({ buffered: 0, sent: 3, failures: 0 });
  });

  it('a full batch is sent without waiting for the timer', async () => {
    const server = fakeServer(202);
    const { store } = make(server.fetch, { buffer: { batchSize: 2, flushIntervalMs: 60_000 } });
    await store.start().record(log('a'));
    await store.record(log('b'));
    await vi.waitFor(() => expect(store.stats().sent).toBe(2));
  });

  it('keeps entries and backs off while the server is down, then delivers them', async () => {
    const server = fakeServer(new Error('ECONNREFUSED'), 503, 202);
    const { store, advance } = make(server.fetch);
    await store.record(log('a'));
    await store.flush();
    expect(store.stats()).toMatchObject({ buffered: 1, failures: 1, lastError: 'ECONNREFUSED' });
    const first = store.stats().nextAttemptAt;
    // While backing off, the timer does not send.
    await (store as unknown as { tick(): Promise<void> }).tick();
    expect(server.calls).toHaveLength(1);
    advance(5000);
    await (store as unknown as { tick(): Promise<void> }).tick();
    expect(store.stats()).toMatchObject({ failures: 2, lastError: 'the server answered 503' });
    // Exponential: the second wait is longer than the first.
    expect(store.stats().nextAttemptAt - (1_000_000 + 5000)).toBeGreaterThan(first - 1_000_000);
    advance(60_000);
    await (store as unknown as { tick(): Promise<void> }).tick();
    expect(store.stats()).toMatchObject({ buffered: 0, sent: 1, failures: 0, lastError: null });
  });

  it('a bounded buffer: past maxEntries the oldest are dropped and counted', async () => {
    const server = fakeServer(new Error('down'));
    const { store } = make(server.fetch, { buffer: { maxEntries: 3, flushIntervalMs: 60_000 } });
    for (const m of ['1', '2', '3', '4', '5']) await store.record(log(m));
    expect(store.stats()).toMatchObject({ buffered: 3, dropped: 2 });
    await store.flush();
    // The failed batch went back to the front: the newest three are kept, in order.
    expect(
      server.calls[0]?.body.entries.map(
        (e) => (e as { content: { message: string } }).content.message,
      ),
    ).toEqual(['3', '4', '5']);
    expect(store.stats()).toMatchObject({ buffered: 3, dropped: 2 });
  });

  it('splits by bytes, halves the batch on 413 and drops what the server refuses', async () => {
    const server = fakeServer(413, 202, 202, 400);
    const { store } = make(server.fetch, { buffer: { batchSize: 4, flushIntervalMs: 60_000 } });
    for (const m of ['a', 'b', 'c', 'd']) await store.record(log(m));
    await store.flush();
    expect(server.calls.map((c) => c.body.entries.length)).toEqual([4, 2, 2]);
    expect(store.stats()).toMatchObject({ sent: 4, rejected: 0 });
    await store.record(log('bad'));
    await store.flush();
    expect(store.stats()).toMatchObject({ rejected: 1, buffered: 0 });

    const bytes = fakeServer(202);
    const small = make(bytes.fetch, { buffer: { maxBatchBytes: 300, flushIntervalMs: 60_000 } });
    for (const m of ['x'.repeat(200), 'y'.repeat(200)]) await small.store.record(log(m));
    await small.store.flush();
    expect(bytes.calls.map((c) => c.body.entries.length)).toEqual([1, 1]);
  });

  it('a refused token is reset so the next send fetches a fresh one', async () => {
    const server = fakeServer(401, 202);
    let issued = 0;
    const token = Object.assign(async () => `t${++issued}`, { reset: vi.fn() });
    const { store, advance } = make(server.fetch, { token });
    await store.record(log('a'));
    await store.flush();
    expect(token.reset).toHaveBeenCalledTimes(1);
    advance(60_000);
    await store.flush();
    expect(server.calls.map((c) => c.headers.authorization)).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('an entry that cannot be serialized is dropped, never thrown', async () => {
    const { store } = make(fakeServer(202).fetch);
    const content: Record<string, unknown> = {};
    content.self = content;
    await expect(store.record({ type: 'log', content })).resolves.toBeTruthy();
    expect(store.stats()).toMatchObject({ buffered: 0, dropped: 1 });
  });

  it('tee: entries are also kept locally and reads come from there', async () => {
    const tee = new InMemoryTelescopeStore();
    const server = fakeServer(202);
    const { store } = make(server.fetch, { tee });
    const entry = await store.record(log('both'));
    expect(await store.get(entry.id)).toMatchObject({ id: entry.id });
    expect(await store.count()).toBe(1);
    expect(typeof (store as unknown as { countTags?: unknown }).countTags).toBe(
      typeof (tee as unknown as { countTags?: unknown }).countTags,
    );
    await store.flush();
    // The same id goes to the server, so a retry is recognised there.
    expect(server.calls[0]?.body.entries[0]).toMatchObject({ id: entry.id });

    const bare = make(server.fetch).store;
    await bare.record(log('remote only'));
    expect(await bare.list()).toEqual([]);
    expect(await bare.count()).toBe(0);
  });

  it('never rewrites app: tags; with relay, its own entries are tagged app:<partition>', async () => {
    const sent = async (relay: boolean) => {
      const tee = new InMemoryTelescopeStore();
      const server = fakeServer(202);
      const { store } = make(server.fetch, { tee, relay });
      await store.record({ type: 'log', content: {}, tags: ['app:billing', 'env:staging'] });
      await store.record(log('own'));
      await store.flush();
      return {
        wire: ((server.calls[0]?.body.entries ?? []) as Array<{ tags: string[] }>).map(
          (e) => e.tags,
        ),
        local: (await tee.list()).map((e) => e.tags).reverse(),
      };
    };
    // Off: tags go out as the code set them (the server drops app: tags without relay rights).
    expect(await sent(false)).toEqual({
      wire: [['app:billing', 'env:staging'], ['level:info']],
      local: [['app:billing', 'env:staging'], ['level:info']],
    });
    // On: relayed tags are kept, locally too, and the relayer's own entries name it.
    expect(await sent(true)).toEqual({
      wire: [
        ['app:billing', 'env:staging'],
        ['level:info', 'app:shop'],
      ],
      local: [
        ['app:billing', 'env:staging'],
        ['level:info', 'app:shop'],
      ],
    });
  });
});
