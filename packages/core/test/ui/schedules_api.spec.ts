import { afterEach, describe, expect, it } from 'vitest';
import { resetTelescopeRuntime, setTelescopeRuntime } from '../../src/registry.js';
import { TelescopeService } from '../../src/service.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';
import { makeRequest, RecordingResponse, type UiHttpContext } from '../../src/ui/http.js';
import { SchedulesApi } from '../../src/ui/schedules_api.js';
import { ScheduleWatcher } from '../../src/watchers/schedule_watcher.js';

function ctx(): { ctx: UiHttpContext; res: RecordingResponse } {
  const res = new RecordingResponse();
  return { ctx: { request: makeRequest('GET'), response: res }, res };
}

describe('SchedulesApi.live', () => {
  afterEach(() => {
    resetTelescopeRuntime();
  });

  it('returns an empty list when no schedule watcher is running (not an error)', async () => {
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    const api = new SchedulesApi(service);
    const { ctx: c, res } = ctx();
    await api.live(c);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { tasks: unknown[] } }).data.tasks).toEqual([]);
  });

  it('joins each registered schedule with its most recent recorded run', async () => {
    const store = new InMemoryTelescopeStore();
    const service = new TelescopeService(store);
    // `ScheduleWatcher.record()` writes through `safeRecord`, which reads the runtime store slot —
    // publish the SAME store `SchedulesApi` queries so recorded runs are actually visible to it.
    setTelescopeRuntime(store, true);
    const watcher = new ScheduleWatcher();
    watcher.start();
    try {
      watcher.register({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' });
      watcher.register({ name: 'never-ran', kind: 'custom' });

      // Two runs of prune-sessions; the API must surface the NEWEST.
      watcher.record({
        name: 'prune-sessions',
        status: 'failed',
        durationMs: 5,
        schedule: '0 * * * *',
      });
      await new Promise((resolve) => setImmediate(resolve));
      watcher.record({
        name: 'prune-sessions',
        status: 'completed',
        durationMs: 42,
        schedule: '0 * * * *',
      });
      await new Promise((resolve) => setImmediate(resolve));

      const api = new SchedulesApi(service);
      const { ctx: c, res } = ctx();
      await api.live(c);
      expect(res.statusCode).toBe(200);
      const tasks = (res.body as { data: { tasks: Array<Record<string, unknown>> } }).data.tasks;
      expect(tasks).toHaveLength(2);

      const pruned = tasks.find((t) => t.name === 'prune-sessions');
      expect(pruned).toMatchObject({ kind: 'cron', lastStatus: 'completed', lastDurationMs: 42 });
      expect(pruned?.nextRunAt).not.toBeNull();

      const neverRan = tasks.find((t) => t.name === 'never-ran');
      expect(neverRan).toMatchObject({
        kind: 'custom',
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
      });
    } finally {
      watcher.stop();
    }
  });
});
