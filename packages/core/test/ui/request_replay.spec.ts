import { describe, expect, it, vi } from 'vitest';
import type { RequestEntryContent } from '../../src/request_watcher.js';
import {
  REPLAY_BODY_CAP,
  REPLAY_STRIPPED_HEADERS,
  REPLAY_TIMEOUT_MS,
  type ReplayTransport,
  replayRequest,
} from '../../src/ui/request_replay.js';

function content(over: Partial<RequestEntryContent> = {}): RequestEntryContent {
  return { method: 'GET', url: '/users', status: 200, durationMs: 5, traceId: null, ...over };
}

/** A transport that records the call it received and returns a canned response. */
function fakeTransport(response: { status?: number; body?: string } = {}): {
  transport: ReplayTransport;
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[];
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
  const transport: ReplayTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { status: response.status ?? 200, text: async () => response.body ?? 'ok' };
  };
  return { transport, calls };
}

describe('replayRequest', () => {
  it('reconstructs method + local URL from a stored request entry', async () => {
    const { transport, calls } = fakeTransport();
    const result = await replayRequest(content({ method: 'GET', url: '/users/42' }), {
      transport,
      port: 3333,
      clock: { now: () => 0 },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3333/users/42');
    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
  });

  it('targets only the local loopback (same-origin safety, never an arbitrary URL)', async () => {
    const { transport, calls } = fakeTransport();
    // Even a path-shaped url stays loopback-only — there is no way to redirect it
    // at another host.
    await replayRequest(content({ url: '/admin' }), { transport, port: 8080 });
    expect(calls[0]?.url.startsWith('http://127.0.0.1:8080')).toBe(true);
  });

  it('normalizes a path missing its leading slash', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content({ url: 'health' }), { transport, port: 3000 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/health');
  });

  it('targets the live request port when provided (no explicit override)', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content({ url: '/users' }), { transport, requestPort: 4321 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4321/users');
  });

  it('lets an explicit config port override the live request port', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content({ url: '/users' }), { transport, port: 9000, requestPort: 4321 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:9000/users');
  });

  it('falls back to the configured replay.port when no live request port is available', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content({ url: '/users' }), { transport, port: 7000 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:7000/users');
  });

  it('falls back to the PORT env when no port/requestPort is given', async () => {
    vi.stubEnv('PORT', '5555');
    try {
      const { transport, calls } = fakeTransport();
      await replayRequest(content({ url: '/users' }), { transport });
      expect(calls[0]?.url).toBe('http://127.0.0.1:5555/users');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the AdonisJS default port 3333 (not 3000) when nothing is provided', async () => {
    vi.stubEnv('PORT', undefined);
    try {
      const { transport, calls } = fakeTransport();
      await replayRequest(content({ url: '/users' }), { transport });
      expect(calls[0]?.url).toBe('http://127.0.0.1:3333/users');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forces the self-identifying x-telescope-replay header', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content(), { transport });
    expect(calls[0]?.headers['x-telescope-replay']).toBe('1');
  });

  it('never forwards credential/session headers (strips cookie/authorization/host)', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content(), { transport });
    const sent = Object.keys(calls[0]?.headers ?? {}).map((k) => k.toLowerCase());
    for (const stripped of REPLAY_STRIPPED_HEADERS) {
      expect(sent).not.toContain(stripped);
    }
  });

  it('caps the returned body at REPLAY_BODY_CAP bytes', async () => {
    const big = 'x'.repeat(REPLAY_BODY_CAP + 500);
    const { transport } = fakeTransport({ body: big });
    const result = await replayRequest(content(), { transport });
    expect(result.body).toHaveLength(REPLAY_BODY_CAP);
  });

  it('never throws: a transport failure resolves to status 0 with an error', async () => {
    const transport: ReplayTransport = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await replayRequest(content(), { transport });
    expect(result.status).toBe(0);
    expect(result.body).toBe('');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('uppercases the captured method', async () => {
    const { transport, calls } = fakeTransport();
    await replayRequest(content({ method: 'post' as string }), { transport });
    expect(calls[0]?.method).toBe('POST');
  });

  it('reports a wall-clock duration from the injected clock', async () => {
    const { transport } = fakeTransport();
    const ticks = [100, 125];
    const result = await replayRequest(content(), {
      transport,
      clock: { now: () => ticks.shift() ?? 999 },
    });
    expect(result.durationMs).toBe(25);
  });

  it('aborts via signal after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const transport: ReplayTransport = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const promise = replayRequest(content(), { transport, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await promise;
      expect(result.status).toBe(0);
      expect(result.error).toContain('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes sane safety constants', () => {
    expect(REPLAY_TIMEOUT_MS).toBe(30_000);
    expect(REPLAY_BODY_CAP).toBe(4096);
    expect([...REPLAY_STRIPPED_HEADERS]).toEqual(
      expect.arrayContaining(['cookie', 'authorization', 'host', 'content-length']),
    );
  });
});
