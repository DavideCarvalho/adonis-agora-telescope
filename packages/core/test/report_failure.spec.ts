import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_WINDOW_MS, reportFailure, resetFailureReports } from '../src/report_failure.js';

beforeEach(() => {
  vi.useFakeTimers();
  resetFailureReports();
});

afterEach(() => {
  resetFailureReports();
  vi.useRealTimers();
});

describe('reportFailure', () => {
  it('prints the first failure at once and folds identical repeats into one count', () => {
    const log = vi.fn();
    for (let i = 0; i < 600; i++) reportFailure('k', 'RedisWatcher: failed: boom', log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('RedisWatcher: failed: boom');

    vi.advanceTimersByTime(REPORT_WINDOW_MS);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      'RedisWatcher: failed: boom (repeated 599 more times in the last 60s)',
    );
  });

  it('prints nothing extra when a failure does not repeat, and reports it afresh later', () => {
    const log = vi.fn();
    reportFailure('k', 'once', log);
    vi.advanceTimersByTime(REPORT_WINDOW_MS);
    expect(log).toHaveBeenCalledTimes(1);
    reportFailure('k', 'once', log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct failures separate', () => {
    const log = vi.fn();
    reportFailure('a', 'a', log);
    reportFailure('b', 'b', log);
    reportFailure('a', 'a', log);
    expect(log.mock.calls).toEqual([['a'], ['b']]);
  });

  it('forwards extra arguments (e.g. the error) on the immediate report', () => {
    const log = vi.fn();
    const err = new Error('x');
    reportFailure('k', 'line', log, err);
    expect(log).toHaveBeenCalledWith('line', err);
  });

  it('keeps summarizing while a failure persists', () => {
    const log = vi.fn();
    reportFailure('k', 'x', log);
    reportFailure('k', 'x', log);
    vi.advanceTimersByTime(REPORT_WINDOW_MS);
    reportFailure('k', 'x', log);
    vi.advanceTimersByTime(REPORT_WINDOW_MS);
    expect(log.mock.calls).toEqual([
      ['x'],
      ['x (repeated 1 more time in the last 60s)'],
      ['x (repeated 1 more time in the last 60s)'],
    ]);
  });
});
