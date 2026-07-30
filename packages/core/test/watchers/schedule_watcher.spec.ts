import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/watchers/define_config.js';
import type { ScheduleEntryContent } from '../../src/watchers/schedule_watcher.js';
import {
  ScheduleWatcher,
  buildScheduleEntry,
  recordScheduledRun,
  scheduleTask,
} from '../../src/watchers/schedule_watcher.js';
import { clearStore, flush, installStore } from './helpers.js';

/** A monotonic fake clock so run durations are deterministic. */
function fakeClock(start = 0): { now(): number; advance(by: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (by: number) => {
      t += by;
    },
  };
}

describe('buildScheduleEntry', () => {
  it('records name, schedule, kind, duration under a schedule family hash + origin', () => {
    const input = buildScheduleEntry({
      name: 'prune-sessions',
      status: 'completed',
      durationMs: 42,
      schedule: '0 * * * *',
      kind: 'cron',
    });
    expect(input.type).toBe('scheduled_task');
    expect(input.familyHash).toBe('schedule:prune-sessions');
    expect(input.origin).toBe('schedule');
    expect(input.durationMs).toBe(42);
    const content = input.content as ScheduleEntryContent;
    expect(content).toMatchObject({
      name: 'prune-sessions',
      schedule: '0 * * * *',
      kind: 'cron',
      status: 'completed',
    });
    expect(input.tags).toEqual(
      expect.arrayContaining([
        'schedule',
        'schedule:cron',
        'task:prune-sessions',
        'status:completed',
      ]),
    );
    expect(input.tags).not.toContain('slow');
  });

  it('tags a slow run and a failed run with its reason', () => {
    const input = buildScheduleEntry(
      { name: 'report', status: 'failed', durationMs: 5000, error: new Error('smtp down') },
      1000,
    );
    expect(input.tags).toContain('slow');
    expect(input.tags).toContain('failed');
    expect((input.content as ScheduleEntryContent).failureReason).toBe('smtp down');
  });
});

describe('ScheduleWatcher', () => {
  afterEach(() => clearStore());

  it('scheduleTask() records a completed run with duration', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ScheduleWatcher({ clock });

    const result = watcher.scheduleTask(
      'prune',
      () => {
        clock.advance(30);
        return 'pruned';
      },
      { schedule: '*/5 * * * *', kind: 'cron' },
    );

    expect(result).toBe('pruned');
    await flush();
    const entry = (await store.list({}))[0]!;
    expect(entry.type).toBe('scheduled_task');
    expect(entry.origin).toBe('schedule');
    expect(entry.durationMs).toBe(30);
    expect((entry.content as ScheduleEntryContent).status).toBe('completed');
  });

  it('scheduleTask() records a failed run and re-throws (async fn)', async () => {
    const store = installStore();
    const watcher = new ScheduleWatcher();

    await expect(
      watcher.scheduleTask('boom', async () => {
        throw new Error('cron boom');
      }),
    ).rejects.toThrow('cron boom');

    await flush();
    const entry = (await store.list({}))[0]!;
    const content = entry.content as ScheduleEntryContent;
    expect(content.status).toBe('failed');
    expect(content.failureReason).toBe('cron boom');
    expect(entry.tags).toContain('failed');
  });

  it('honours the slow-run threshold tag', async () => {
    const store = installStore();
    const clock = fakeClock();
    const watcher = new ScheduleWatcher({ slowMs: 100, clock });

    watcher.scheduleTask('slow', () => clock.advance(250));

    await flush();
    const entry = (await store.list({}))[0]!;
    expect(entry.tags).toContain('slow');
  });

  it('records nothing while paused (overload shed)', async () => {
    const store = installStore();
    const { setTelescopePaused } = await import('../../src/registry.js');
    setTelescopePaused(true);
    try {
      new ScheduleWatcher().record({ name: 'x', status: 'completed', durationMs: 1 });
      await flush();
      expect(await store.count()).toBe(0);
    } finally {
      setTelescopePaused(false);
    }
  });
});

describe('standalone scheduleTask()/recordScheduledRun() (opt-in default slot)', () => {
  afterEach(() => clearStore());

  it('is a no-op passthrough when no watcher is published', async () => {
    const store = installStore();
    expect(scheduleTask('x', () => 7)).toBe(7);
    recordScheduledRun({ name: 'y', status: 'completed', durationMs: 1 });
    await flush();
    expect(await store.count()).toBe(0);
  });

  it('records through the published default once the watcher is started, and stops after', async () => {
    const store = installStore();
    const watcher = new ScheduleWatcher();
    watcher.start();
    try {
      recordScheduledRun({ name: 'prune', status: 'completed', durationMs: 5 });
      expect(scheduleTask('report', () => 'ok')).toBe('ok');
      await flush();
      expect(await store.count()).toBe(2);
    } finally {
      watcher.stop();
    }
    recordScheduledRun({ name: 'after', status: 'completed', durationMs: 1 });
    await flush();
    expect(await store.count()).toBe(2);
  });
});

describe('watchers config — schedule', () => {
  it('defaults the schedule watcher config (1000ms slow)', () => {
    const { schedule } = resolveConfig();
    expect(schedule.slowMs).toBe(1000);
  });

  it('honours an explicit schedule config and can be enabled', () => {
    const config = resolveConfig({
      watchers: ['query', 'schedule'],
      schedule: { slowMs: 250 },
    });
    expect(config.watchers.has('schedule')).toBe(true);
    expect(config.schedule.slowMs).toBe(250);
  });
});
