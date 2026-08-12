import { createRequire } from 'node:module';

/** The slice of a `cron-parser` `CronExpression` we consume. */
interface CronExpressionLike {
  next(): { toDate(): Date };
}
type CronParseFn = (
  expression: string,
  options?: { currentDate?: Date; tz?: string },
) => CronExpressionLike;

/**
 * Cache the resolved parse function (or `null` when the peer is absent/broken) so we only
 * `require('cron-parser')` once per process, and only when a `cron`-kind schedule is actually
 * registered — mirroring the rest of this package's "never import an optional peer eagerly" stance.
 */
let cached: CronParseFn | null | undefined;

/**
 * Lazily load `cron-parser`'s expression parser, tolerating BOTH shapes the library has shipped:
 *
 *  - **v4** (`cron-parser@4.x`, what `@adonis-agora/durable` pins in its devDependencies and what
 *    this package's peer range was chosen to match): a top-level `parseExpression(expr, opts)`.
 *  - **v5** (`cron-parser@5.x`): `parseExpression` was REMOVED from the top level; the equivalent
 *    is the static `CronExpressionParser.parse(expr, opts)`.
 *
 * `@adonis-agora/durable`'s own `scheduler.ts` peer range (`^4.0.0 || ^5.0.0`) claims both are
 * supported but its code only calls the v4-shaped `parser.parseExpression` — under a real
 * `cron-parser@5.x` install that throws (confirmed against the published v5 `dist/index.js`, which
 * exports no top-level `parseExpression`). This loader fixes that gap for OUR peer range rather than
 * repeating it: it tries the v4 shape, then the v5 shape, so `nextCronRunMs` genuinely works under
 * either major version we advertise support for.
 *
 * Returns `null` when `cron-parser` is not installed (or exposes neither shape) — the OPTIONAL peer
 * is genuinely optional: without it, `nextRunAt` for `cron`-kind schedules is `null` ("unknown")
 * rather than the registry throwing or the whole feature refusing to boot.
 */
function loadCronParse(): CronParseFn | null {
  if (cached !== undefined) return cached;
  try {
    const requireFn = createRequire(import.meta.url);
    const mod = requireFn('cron-parser') as Record<string, unknown>;
    const v4 = mod.parseExpression as CronParseFn | undefined;
    const v5Class = mod.CronExpressionParser as { parse?: CronParseFn } | undefined;
    const v5 = typeof v5Class?.parse === 'function' ? v5Class.parse.bind(v5Class) : undefined;
    cached = v4 ?? v5 ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The next fire time (epoch ms) for a cron expression, strictly after `fromMs`. Returns `null` when
 * `cron-parser` isn't installed, or the expression fails to parse (never throws).
 */
export function nextCronRunMs(
  expression: string,
  fromMs: number,
  timezone?: string | null,
): number | null {
  const parse = loadCronParse();
  if (parse === null) return null;
  try {
    const interval = parse(expression, {
      // +1ms so a `fromMs` that lands exactly on a fire time still returns the NEXT one, not itself.
      currentDate: new Date(fromMs + 1),
      ...(timezone ? { tz: timezone } : {}),
    });
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

/** Exposed for tests that need to reset the module-level cache between "peer present/absent" cases. */
export function __resetCronParserCacheForTests(): void {
  cached = undefined;
}
