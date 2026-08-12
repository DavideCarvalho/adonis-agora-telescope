import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../src/profiling/define_config.js';
import { ProfilerService } from '../../src/profiling/profiler_service.js';
import type { ProfilerLike } from '../../src/profiling/profiler_service.js';
import type { CpuProfileContent } from '../../src/profiling/types.js';

function fakeProfiler(overrides: Partial<ProfilerLike> = {}): ProfilerLike {
  return {
    isRunning: true,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue({
      tree: { name: '(root)', file: '', selfMs: 0, totalMs: 10, totalSamples: 1, children: [] },
      durationMs: 10,
      sampleCount: 1,
      hot: [],
    }),
    ...overrides,
  };
}

describe('ProfilerService', () => {
  it('shouldProfile/begin are inert while disabled — never constructs a profiler', () => {
    const factory = vi.fn();
    const service = new ProfilerService(resolveConfig({ enabled: false }), {
      profilerFactory: factory,
    });
    expect(service.shouldProfile('GET /x')).toBe(false);
    expect(service.begin('GET /x')).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('arm() is a no-op while disabled', () => {
    const service = new ProfilerService(resolveConfig({ enabled: false }));
    expect(service.arm({ count: 3 })).toEqual({ pendingManual: 0 });
  });

  it('an armed capture is selected regardless of sampleRate, and consumes the budget', () => {
    const service = new ProfilerService(resolveConfig({ enabled: true, sampleRate: 0 }), {
      profilerFactory: () => fakeProfiler(),
    });
    expect(service.arm({ count: 1 })).toEqual({ pendingManual: 1 });
    expect(service.shouldProfile('GET /x')).toBe(true);
    const handle = service.begin('GET /x');
    expect(handle).not.toBeNull();
    expect(handle?.reason).toBe('manual');
    expect(service.status().pendingManual).toBe(0);
  });

  it('a labelled arm only matches its exact label', () => {
    const service = new ProfilerService(resolveConfig({ enabled: true }), {
      profilerFactory: () => fakeProfiler(),
    });
    service.arm({ count: 1, label: 'GET /users/:id' });
    expect(service.shouldProfile('GET /orders')).toBe(false);
    expect(service.shouldProfile('GET /users/:id')).toBe(true);
  });

  it('respects the concurrency cap: a request over maxConcurrent gets no handle', () => {
    const service = new ProfilerService(resolveConfig({ enabled: true, maxConcurrent: 1 }), {
      profilerFactory: () => fakeProfiler(),
    });
    service.arm({ count: 2 });
    const first = service.begin('GET /x');
    expect(first).not.toBeNull();
    const second = service.begin('GET /x');
    expect(second).toBeNull();
    // The capped request must not have consumed the manual budget.
    expect(service.status().pendingManual).toBe(1);
  });

  it('records a completed capture as a cpu_profile RecordInput via the injected record fn', async () => {
    const record = vi.fn();
    const service = new ProfilerService(resolveConfig({ enabled: true, minDurationMs: 0 }), {
      profilerFactory: () => fakeProfiler(),
      record,
    });
    service.arm({ count: 1 });
    const handle = service.begin('GET /x');
    await service.end(handle, 'GET /x');
    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0]?.[0];
    expect(input.type).toBe('cpu_profile');
    expect(input.familyHash).toBe('GET /x');
    const content = input.content as CpuProfileContent;
    expect(content.reason).toBe('manual');
    expect(content.durationMs).toBe(10);
  });

  it('discards a capture below minDurationMs', async () => {
    const record = vi.fn();
    const service = new ProfilerService(resolveConfig({ enabled: true, minDurationMs: 1000 }), {
      profilerFactory: () =>
        fakeProfiler({
          stop: vi.fn().mockResolvedValue({
            tree: {
              name: '(root)',
              file: '',
              selfMs: 0,
              totalMs: 1,
              totalSamples: 1,
              children: [],
            },
            durationMs: 1,
            sampleCount: 1,
            hot: [],
          }),
        }),
      record,
    });
    service.arm({ count: 1 });
    const handle = service.begin('GET /x');
    await service.end(handle, 'GET /x');
    expect(record).not.toHaveBeenCalled();
  });

  it('end() with a null handle is a no-op', async () => {
    const record = vi.fn();
    const service = new ProfilerService(resolveConfig({ enabled: true }), { record });
    await service.end(null, 'GET /x');
    expect(record).not.toHaveBeenCalled();
  });

  it('a capture that throws on stop() never propagates and still frees the active slot', async () => {
    const record = vi.fn();
    const service = new ProfilerService(resolveConfig({ enabled: true, maxConcurrent: 1 }), {
      profilerFactory: () => fakeProfiler({ stop: vi.fn().mockRejectedValue(new Error('boom')) }),
      record,
    });
    service.arm({ count: 1 });
    const handle = service.begin('GET /x');
    await expect(service.end(handle, 'GET /x')).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(service.status().active).toBe(0);
  });

  it('status() reports enabled/sampleRate/active/maxConcurrent/pendingManual', () => {
    const service = new ProfilerService(
      resolveConfig({ enabled: true, sampleRate: 0.5, maxConcurrent: 3 }),
    );
    expect(service.status()).toEqual({
      enabled: true,
      sampleRate: 0.5,
      active: 0,
      maxConcurrent: 3,
      pendingManual: 0,
    });
  });
});
