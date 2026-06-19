const DURATION_UNITS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type DurationUnit = keyof typeof DURATION_UNITS;

/**
 * Convert a duration (a raw ms number, or a `<int><ms|s|m|h|d>` string such as
 * `'15m'`) to milliseconds. Throws on an unparseable string so a typo in config
 * surfaces at boot rather than silently never firing.
 *
 * Ported verbatim from the aviary telescope core's `durationToMs` — this package
 * keeps its own copy so it never depends on a core internal that isn't exported.
 */
export function durationToMs(duration: number | string): number {
  if (typeof duration === 'number') {
    return duration;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (match === null) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  const unit = match[2] as DurationUnit;
  return Number(match[1]) * DURATION_UNITS[unit];
}
