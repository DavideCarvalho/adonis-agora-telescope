import { describe, expect, it } from 'vitest';
import {
  listRegisteredSchedules,
  registerSchedule,
  ScheduleWatcher,
  toRegisteredSchedule,
  unregisterSchedule,
} from '../../src/watchers/schedule_watcher.js';

describe('ScheduleWatcher registration registry', () => {
  it('register/list/unregister on a single watcher instance', () => {
    const watcher = new ScheduleWatcher();
    watcher.register({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' });
    watcher.register({ name: 'send-report', schedule: '0 9 * * MON', kind: 'cron' });
    expect(watcher.list().map((t) => t.name)).toEqual(['prune-sessions', 'send-report']);

    watcher.unregister('prune-sessions');
    expect(watcher.list().map((t) => t.name)).toEqual(['send-report']);
  });

  it('re-registering the same name replaces the prior registration (idempotent)', () => {
    const watcher = new ScheduleWatcher();
    watcher.register({ name: 'x', schedule: '0 * * * *', kind: 'cron' });
    watcher.register({ name: 'x', schedule: '*/5 * * * *', kind: 'cron' });
    const list = watcher.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.schedule).toBe('*/5 * * * *');
  });

  it('computes nextRunAt for cron-kind schedules, null for interval/custom', () => {
    const watcher = new ScheduleWatcher();
    watcher.register({ name: 'cron-task', schedule: '0 * * * *', kind: 'cron' });
    watcher.register({ name: 'interval-task', kind: 'interval' });
    const list = watcher.list();
    expect(list.find((t) => t.name === 'cron-task')?.nextRunAt).not.toBeNull();
    expect(list.find((t) => t.name === 'interval-task')?.nextRunAt).toBeNull();
  });
});

describe('toRegisteredSchedule', () => {
  it('defaults kind to cron and normalizes a missing schedule/timezone to null', () => {
    const result = toRegisteredSchedule({ name: 'bare' }, Date.now());
    expect(result).toMatchObject({
      name: 'bare',
      kind: 'cron',
      schedule: null,
      timezone: null,
      pool: null,
    });
  });

  it('carries the pinned worker pool through to the listed schedule', () => {
    // The durable extension fills `pool` from the schedule's pinned run-namespace, so the console
    // can show which pool actually services a recurring run (the partition that keeps capability-
    // bound steps off pools that cannot run them).
    const result = toRegisteredSchedule(
      { name: 'bula-harvest', kind: 'cron', schedule: '0 3 * * *', pool: 'bulas' },
      Date.now(),
    );
    expect(result.pool).toBe('bulas');
  });
});

describe('registerSchedule / unregisterSchedule / listRegisteredSchedules (default-slot helpers)', () => {
  it('are a no-op / empty when no watcher has started', () => {
    expect(() => registerSchedule({ name: 'x', kind: 'cron' })).not.toThrow();
    expect(listRegisteredSchedules()).toEqual([]);
    expect(() => unregisterSchedule('x')).not.toThrow();
  });

  it('route through the started watcher once published', () => {
    const watcher = new ScheduleWatcher();
    watcher.start();
    try {
      registerSchedule({ name: 'prune-sessions', schedule: '0 * * * *', kind: 'cron' });
      expect(listRegisteredSchedules().map((t) => t.name)).toEqual(['prune-sessions']);
      unregisterSchedule('prune-sessions');
      expect(listRegisteredSchedules()).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});
