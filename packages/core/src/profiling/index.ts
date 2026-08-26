/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.9.1';

export { defineConfig, resolveConfig } from './define_config.js';
export type {
  ResolvedTelescopeCpuProfilingConfig,
  TelescopeCpuProfilingConfig,
} from './define_config.js';

export {
  CPU_PROFILE_ENTRY_TYPE,
  ProfilerService,
} from './profiler_service.js';
export type {
  ProfileHandle,
  ProfilerLike,
  ProfilerServiceDeps,
  ProfilerStatus,
} from './profiler_service.js';

export { CpuProfiler, defaultSessionFactory } from './cpu-profiler.js';
export type {
  CpuProfilerOptions,
  CpuProfilerResult,
  InspectorSessionLike,
  SessionFactory,
} from './cpu-profiler.js';

export { aggregateCpuProfile } from './aggregate-profile.js';
export type {
  CpuProfileContent,
  FlameNode,
  HotFrame,
  V8CpuProfile,
  V8ProfileNode,
} from './types.js';
