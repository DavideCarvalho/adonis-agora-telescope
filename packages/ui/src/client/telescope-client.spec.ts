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

  it('fetches the retention/sampling posture', async () => {
    const { fetch, calls } = stubFetch({
      data: {
        enabled: true,
        afterMs: 86_400_000,
        keepLast: null,
        intervalMs: 60_000,
        sampling: [],
      },
    });
    const info = await client(fetch).retention();
    expect(info.enabled).toBe(true);
    expect(calls[0]).toBe('/telescope/api/retention');
  });

  it('fetches extension meta (dashboards + entry types)', async () => {
    const { fetch, calls } = stubFetch({
      data: { entryTypes: [], dashboards: [{ id: 'durable.runs', label: 'Runs', panels: [] }] },
    });
    const meta = await client(fetch).meta();
    expect(meta.dashboards).toHaveLength(1);
    expect(calls[0]).toBe('/telescope/api/meta');
  });

  it('normalizes a 404 from /meta to an empty meta payload (no extensions installed)', async () => {
    const { fetch } = stubFetch({ error: 'not found' }, false, 404);
    const meta = await client(fetch).meta();
    expect(meta).toEqual({ entryTypes: [], dashboards: [] });
  });

  it('resolves an extension panel data provider under its owning namespace', async () => {
    const { fetch, calls } = stubFetch({ data: { value: 42 } });
    const result = await client(fetch).extData<{ value: number }>('durable', 'durable.state', {
      n: '3',
    });
    expect(result.value).toBe(42);
    expect(calls[0]).toContain('/telescope/api/ext/durable/data/durable.state?');
    expect(calls[0]).toContain('n=3');
  });

  it('diagnoses an exception entry (POST) and unwraps the data envelope', async () => {
    const { fetch, calls } = stubFetch({ data: { markdown: '## Probable cause', cached: false } });
    const outcome = await client(fetch).diagnoseException('e1');
    expect(outcome).toEqual({ ok: true, markdown: '## Probable cause', cached: false });
    expect(calls[0]).toBe('/telescope/api/exceptions/e1/diagnose');
  });

  it('passes force=true through to the diagnose route', async () => {
    const { fetch, calls } = stubFetch({ data: { markdown: 'x', cached: false } });
    await client(fetch).diagnoseException('e1', true);
    expect(calls[0]).toContain('/telescope/api/exceptions/e1/diagnose?');
    expect(calls[0]).toContain('force=true');
  });

  it('normalizes a diagnose failure to { ok: false, message } instead of throwing', async () => {
    const { fetch } = stubFetch({ error: 'AI diagnosis is not configured.' }, false, 404);
    const outcome = await client(fetch).diagnoseException('e1');
    expect(outcome).toEqual({ ok: false, message: 'AI diagnosis is not configured.' });
  });

  it('replays a request entry (POST) and unwraps the data envelope', async () => {
    const { fetch, calls } = stubFetch({ data: { status: 200, durationMs: 12, body: 'ok' } });
    const outcome = await client(fetch).replayRequest('e1');
    expect(outcome).toEqual({ ok: true, status: 200, durationMs: 12, body: 'ok' });
    expect(calls[0]).toBe('/telescope/api/requests/e1/replay');
  });

  it('normalizes a replay failure to { ok: false, message } instead of throwing', async () => {
    const { fetch } = stubFetch({ error: 'Request replay is disabled.' }, false, 403);
    const outcome = await client(fetch).replayRequest('e1');
    expect(outcome).toEqual({ ok: false, message: 'Request replay is disabled.' });
  });

  it('throws TelescopeApiError with the status on a non-2xx response', async () => {
    const { fetch } = stubFetch({ error: 'nope' }, false, 403);
    await expect(client(fetch).listEntries()).rejects.toMatchObject({
      name: 'TelescopeApiError',
      status: 403,
    });
    await expect(client(fetch).listEntries()).rejects.toBeInstanceOf(TelescopeApiError);
  });

  // ── CPU profiling ──────────────────────────────────────────────────────

  it('fetches profiler status, normalizing a 404 (feature not installed) to null', async () => {
    const configured = client(stubFetch({ data: { enabled: true, sampleRate: 0.1 } }).fetch);
    expect(await configured.profilerStatus()).toEqual({ enabled: true, sampleRate: 0.1 });

    const unconfigured = client(stubFetch({ error: 'not installed' }, false, 404).fetch);
    expect(await unconfigured.profilerStatus()).toBeNull();
  });

  it('lists captured profiles', async () => {
    const { fetch, calls } = stubFetch({ data: [{ id: 'p1', type: 'cpu_profile' }] });
    const rows = await client(fetch).profiles(50);
    expect(rows).toEqual([{ id: 'p1', type: 'cpu_profile' }]);
    expect(calls[0]).toContain('/telescope/api/profiles?');
    expect(calls[0]).toContain('limit=50');
  });

  it('fetches one profile by id', async () => {
    const { fetch, calls } = stubFetch({ data: { id: 'p1', content: {} } });
    await client(fetch).profile('p1');
    expect(calls[0]).toBe('/telescope/api/profiles/p1');
  });

  it('arms a capture and unwraps pendingManual', async () => {
    const { fetch, calls } = stubFetch({ data: { pendingManual: 2 } });
    const outcome = await client(fetch).armProfile(2, 'GET /x');
    expect(outcome).toEqual({ ok: true, pendingManual: 2 });
    expect(calls[0]).toContain('/telescope/api/profiles/arm?');
    expect(calls[0]).toContain('count=2');
    expect(calls[0]).toContain('label=GET');
  });

  it('normalizes an arm failure to { ok: false, message }', async () => {
    const { fetch } = stubFetch({ error: 'CPU profiling is disabled.' }, false, 400);
    const outcome = await client(fetch).armProfile(1);
    expect(outcome).toEqual({ ok: false, message: 'CPU profiling is disabled.' });
  });

  // ── live queue manager ───────────────────────────────────────────────────

  it('fetches the live queue list, normalizing a 404 (not configured) to null', async () => {
    const configured = client(
      stubFetch({ data: { queues: [], capabilities: { mutationsEnabled: false, actions: [] } } })
        .fetch,
    );
    expect(await configured.liveQueues()).toEqual({
      queues: [],
      capabilities: { mutationsEnabled: false, actions: [] },
    });

    const unconfigured = client(stubFetch({ error: 'not configured' }, false, 404).fetch);
    expect(await unconfigured.liveQueues()).toBeNull();
  });

  it('fetches one job by id, normalizing a 404 to null', async () => {
    const found = client(stubFetch({ data: { id: 'j1', name: 'Send' } }).fetch);
    expect(await found.queueJob('emails', 'j1')).toEqual({ id: 'j1', name: 'Send' });

    const missing = client(stubFetch({ error: 'no job' }, false, 404).fetch);
    expect(await missing.queueJob('emails', 'nope')).toBeNull();
  });

  it('retries a job (POST) and normalizes a failure to { ok: false, message }', async () => {
    const ok = client(stubFetch({ data: { ok: true } }).fetch);
    expect(await ok.retryJob('emails', 'j1')).toEqual({ ok: true });

    const failed = client(stubFetch({ error: 'does not support' }, false, 501).fetch);
    expect(await failed.retryJob('emails', 'j1')).toEqual({
      ok: false,
      message: 'does not support',
    });
  });

  it('enqueues a job (POST with a JSON body) and unwraps the assigned id', async () => {
    const { fetch, calls } = stubFetch({ data: { id: 'job-9' } });
    const outcome = await client(fetch).enqueueJob('emails', { to: 'a@b.com' }, 'SendWelcome');
    expect(outcome).toEqual({ ok: true, id: 'job-9' });
    expect(calls[0]).toBe('/telescope/api/queues/live/emails/enqueue');
  });

  it('normalizes an enqueue failure to { ok: false, message }', async () => {
    const { fetch } = stubFetch({ error: 'does not support enqueueing' }, false, 501);
    const outcome = await client(fetch).enqueueJob('emails', {});
    expect(outcome).toEqual({ ok: false, message: 'does not support enqueueing' });
  });

  // ── live schedules ───────────────────────────────────────────────────────

  it('fetches the live schedules list', async () => {
    const { fetch, calls } = stubFetch({ data: { tasks: [{ name: 'prune-sessions' }] } });
    const result = await client(fetch).liveSchedules();
    expect(result.tasks).toHaveLength(1);
    expect(calls[0]).toBe('/telescope/api/schedules/live');
  });
});
