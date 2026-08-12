/**
 * The shape of `config/telescope_cpu_profiling.ts`. Mirrors `nestjs-telescope`'s
 * `profiling-config.ts` (`ResolvedProfilingConfig`) — the knobs are framework-agnostic (they gate a
 * `node:inspector` capture, not anything NestJS/AdonisJS-specific).
 */
export interface TelescopeCpuProfilingConfig {
  /**
   * Master switch. CPU profiling carries real overhead (a running V8 sampling
   * profiler slows the process it profiles), so it is OFF by default — opt in
   * explicitly. When `false` the middleware hook is a single boolean check and
   * `node:inspector` is never required. Default `false`.
   */
  enabled?: boolean;
  /**
   * Fraction (0–1) of requests to automatically capture. `0` (the default) means
   * captures only happen when armed via `POST <path>/api/profiles/arm`.
   */
  sampleRate?: number;
  /** Maximum concurrent captures. Keeps overhead bounded under load. Default 2. */
  maxConcurrent?: number;
  /** Captures shorter than this are discarded (not worth an entry). Default 5. */
  minDurationMs?: number;
  /** V8 sampling interval in microseconds (lower = finer-grained, more overhead). Default 1000. */
  samplingIntervalMicros?: number;
}

/** The fully-resolved config the provider + `ProfilerService` act on (no optionals). */
export interface ResolvedTelescopeCpuProfilingConfig {
  enabled: boolean;
  sampleRate: number;
  maxConcurrent: number;
  minDurationMs: number;
  samplingIntervalMicros: number;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MIN_DURATION_MS = 5;
const DEFAULT_SAMPLING_INTERVAL_MICROS = 1000;

/** Identity helper giving `config/telescope_cpu_profiling.ts` full type-checking. */
export function defineConfig(config: TelescopeCpuProfilingConfig): TelescopeCpuProfilingConfig {
  return config;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(
  config: TelescopeCpuProfilingConfig = {},
): ResolvedTelescopeCpuProfilingConfig {
  return {
    enabled: config.enabled ?? false,
    sampleRate: clamp01(config.sampleRate ?? 0),
    maxConcurrent: Math.max(1, Math.floor(config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)),
    minDurationMs: Math.max(0, config.minDurationMs ?? DEFAULT_MIN_DURATION_MS),
    samplingIntervalMicros: Math.max(
      100,
      Math.floor(config.samplingIntervalMicros ?? DEFAULT_SAMPLING_INTERVAL_MICROS),
    ),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
