import { randomUUID } from 'node:crypto';
import { durationToMs } from '../alerts/parse_duration.js';
import { runAsTelescopeWork } from '../self_scope.js';

/** A check's state: `ok`, `warn` (degraded, still serving) or `down`. `unknown` before the first run. */
export type CheckStatus = 'ok' | 'warn' | 'down' | 'unknown';

/** What one run of a check returns. */
export interface CheckOutcome {
  status: 'ok' | 'warn' | 'down';
  /** One line for the console and the alert. */
  message?: string;
  /** Extra numbers to show (memory used, latency…). Kept small. */
  meta?: Record<string, string | number | boolean | null>;
}

/** What a check can reach while it runs. */
export interface CheckContext {
  /** Resolve a container binding (`redis`, `lucid.db`, …). */
  make(binding: string): Promise<unknown>;
}

/** A telescope health check: `checks.redis()`, `checks.lucid()`, `checks.custom()`. */
export interface TelescopeCheck {
  readonly name: string;
  /** How long a result is reused. Default `30s`. */
  readonly cacheFor?: number | string;
  /** A run taking longer is `down`. Default `5s`. */
  readonly timeout?: number | string;
  /**
   * Whether a `down` makes the instance not ready (the readiness route answers 503). Default
   * `true`; a `false` check is shown and alerted on but never takes the instance out of rotation.
   */
  readonly critical?: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

/**
 * The shape of an `@adonisjs/core/health` check (`DiskSpaceCheck`, `MemoryHeapCheck`, a
 * `BaseCheck` of your own): `run()` answers `{ status: 'ok' | 'warning' | 'error', message }`.
 */
export interface AdonisHealthCheckLike {
  name: string;
  /** Seconds (set by `BaseCheck#cacheFor()`). */
  cacheDuration?: number;
  run(): Promise<{ status: string; message?: string; meta?: unknown }>;
}

/** Anything `checks` in `config/telescope.ts` accepts. */
export type TelescopeCheckInput = TelescopeCheck | AdonisHealthCheckLike;

/** The last known result of a check, as the console, the heartbeat and the alerts see it. */
export interface CheckState {
  name: string;
  status: CheckStatus;
  message: string | null;
  /** Epoch ms since the check has been in this status (a `down` since 12 minutes ago). */
  since: number;
  /** Epoch ms of the run this state comes from (0 before the first run). */
  checkedAt: number;
  durationMs: number | null;
  critical: boolean;
  meta?: Record<string, string | number | boolean | null>;
}

const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MESSAGE = 300;

function ms(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = durationToMs(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function oneLine(text: unknown): string {
  const value = text instanceof Error ? text.message : String(text);
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
}

/** Whether `value` is a telescope check (or an AdonisJS one). */
export function isCheckInput(value: unknown): value is TelescopeCheckInput {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    (value as { name: string }).name !== '' &&
    typeof (value as { run?: unknown }).run === 'function'
  );
}

/** Adapt an `@adonisjs/core/health` check (its `cacheDuration`; `warning`/`error` are mapped on run). */
function fromInput(input: TelescopeCheckInput): TelescopeCheck {
  const own = input as Partial<TelescopeCheck> & Partial<AdonisHealthCheckLike>;
  // An AdonisJS `BaseCheck` has a `cacheFor()` METHOD and keeps the duration in seconds.
  const cacheFor =
    typeof own.cacheFor === 'number' || typeof own.cacheFor === 'string'
      ? own.cacheFor
      : typeof own.cacheDuration === 'number'
        ? own.cacheDuration * 1000
        : undefined;
  return {
    name: input.name,
    ...(cacheFor !== undefined ? { cacheFor } : {}),
    ...(own.timeout !== undefined ? { timeout: own.timeout } : {}),
    ...(own.critical !== undefined ? { critical: own.critical } : {}),
    run: (ctx) => (input as TelescopeCheck).run(ctx),
  };
}

function normalizeOutcome(result: {
  status: string;
  message?: string;
  meta?: unknown;
}): CheckOutcome {
  const status =
    result?.status === 'ok'
      ? 'ok'
      : result?.status === 'warn' || result?.status === 'warning'
        ? 'warn'
        : 'down';
  return {
    status,
    ...(typeof result?.message === 'string' && result.message !== ''
      ? { message: result.message }
      : {}),
    ...(isFlatMeta(result?.meta) ? { meta: result.meta } : {}),
  };
}

function isFlatMeta(value: unknown): value is Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

interface Slot {
  check: TelescopeCheck;
  cacheMs: number;
  timeoutMs: number;
  critical: boolean;
  state: CheckState;
  inflight: Promise<CheckState> | null;
}

/** Options of {@link HealthChecks}. */
export interface HealthChecksOptions {
  /** Resolves container bindings for the built-in checks. */
  make?: (binding: string) => Promise<unknown>;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** The overall answer of a set of checks. */
export interface HealthReport {
  /** `down` when a critical check is down, `warn` when any check is not ok, else `ok`. */
  status: 'ok' | 'warn' | 'down';
  checks: CheckState[];
}

/**
 * The configured checks of this process. Each result is reused for its `cacheFor` (default 30 s)
 * and concurrent callers share one run (single-flight), so a kubelet probing every second and the
 * heartbeat every 15 s cost one `PING` / `SELECT 1` per 30 s.
 */
export class HealthChecks {
  private readonly slots: Slot[];
  private readonly now: () => number;
  private readonly ctx: CheckContext;

  constructor(inputs: readonly TelescopeCheckInput[], options: HealthChecksOptions = {}) {
    this.now = options.now ?? Date.now;
    const make =
      options.make ??
      (async (binding: string) => {
        throw new Error(`the container binding "${binding}" is not available`);
      });
    this.ctx = { make };
    const names = new Set<string>();
    this.slots = inputs.map((input) => {
      if (!isCheckInput(input)) {
        throw new Error(
          '[@adonis-agora/telescope] every entry of `checks` must be checks.redis(), checks.lucid(), checks.custom() or an @adonisjs/core/health check',
        );
      }
      if (names.has(input.name)) {
        throw new Error(`[@adonis-agora/telescope] two checks are named "${input.name}"`);
      }
      names.add(input.name);
      const check = fromInput(input);
      return {
        check,
        cacheMs: ms(check.cacheFor, DEFAULT_CACHE_MS),
        timeoutMs: ms(check.timeout, DEFAULT_TIMEOUT_MS),
        critical: check.critical !== false,
        state: {
          name: check.name,
          status: 'unknown',
          message: null,
          since: this.now(),
          checkedAt: 0,
          durationMs: null,
          critical: check.critical !== false,
        },
        inflight: null,
      };
    });
  }

  /** How many checks are configured. */
  get size(): number {
    return this.slots.length;
  }

  /** The last known states, without running anything. */
  states(): CheckState[] {
    return this.slots.map((slot) => ({ ...slot.state }));
  }

  /** Run every check whose cached result is stale (sharing a run already in flight). */
  async run(): Promise<CheckState[]> {
    return Promise.all(this.slots.map((slot) => this.runSlot(slot)));
  }

  /** Run (as needed) and summarize. */
  async report(): Promise<HealthReport> {
    return summarizeChecks(await this.run());
  }

  private runSlot(slot: Slot): Promise<CheckState> {
    const now = this.now();
    if (slot.state.checkedAt !== 0 && now - slot.state.checkedAt < slot.cacheMs) {
      return Promise.resolve({ ...slot.state });
    }
    if (slot.inflight !== null) return slot.inflight;
    const run = this.execute(slot).finally(() => {
      slot.inflight = null;
    });
    slot.inflight = run;
    return run;
  }

  private async execute(slot: Slot): Promise<CheckState> {
    const started = this.now();
    let outcome: CheckOutcome;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await runAsTelescopeWork(() =>
        Promise.race([
          slot.check
            .run(this.ctx)
            .then((result) => normalizeOutcome(result as { status: string; message?: string })),
          new Promise<CheckOutcome>((resolve) => {
            timer = setTimeout(
              () => resolve({ status: 'down', message: `timed out after ${slot.timeoutMs} ms` }),
              slot.timeoutMs,
            );
            timer.unref?.();
          }),
        ]),
      );
    } catch (error) {
      outcome = { status: 'down', message: oneLine(error) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const finished = this.now();
    const previous = slot.state;
    slot.state = {
      name: slot.check.name,
      status: outcome.status,
      message: outcome.message !== undefined ? oneLine(outcome.message) : null,
      since: previous.status === outcome.status ? previous.since : finished,
      checkedAt: finished,
      durationMs: Math.max(0, finished - started),
      critical: slot.critical,
      ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
    };
    return { ...slot.state };
  }
}

/** The overall status of some check states. */
export function summarizeChecks(states: CheckState[]): HealthReport {
  let status: HealthReport['status'] = 'ok';
  for (const state of states) {
    if (state.status === 'down' && state.critical) return { status: 'down', checks: states };
    if (state.status !== 'ok') status = 'warn';
  }
  return { status, checks: states };
}

/** Options shared by the built-in checks. */
export interface CheckOptions {
  /** The name shown in the console and in alerts. */
  name?: string;
  /** How long a result is reused. Default `30s`. */
  cacheFor?: number | string;
  /** A run taking longer is `down`. Default `5s`. */
  timeout?: number | string;
  /** Whether a `down` takes the instance out of rotation (readiness 503). Default `true`. */
  critical?: boolean;
}

/** Options of `checks.redis()`. */
export interface RedisCheckOptions extends CheckOptions {
  /** A connection of `config/redis.ts`. Default the default connection. */
  connection?: string;
  /**
   * Also write a short-lived key, so a Redis that answers `PING` but refuses writes
   * (`maxmemory` reached with `noeviction`: "OOM command not allowed") is `down`. Default `true`.
   */
  write?: boolean;
  /** `used_memory / maxmemory` at or above which the check is `warn`. Default `0.9`. */
  memoryWarnRatio?: number;
}

/** Options of `checks.lucid()`. */
export interface LucidCheckOptions extends CheckOptions {
  /** A connection of `config/database.ts`. Default the default connection. */
  connection?: string;
}

interface RedisConnectionLike {
  ping(): Promise<unknown>;
  set?(...args: unknown[]): Promise<unknown>;
  info?(section?: string): Promise<string>;
}

function base(name: string, options: CheckOptions) {
  return {
    name: options.name ?? name,
    ...(options.cacheFor !== undefined ? { cacheFor: options.cacheFor } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.critical !== undefined ? { critical: options.critical } : {}),
  };
}

/** Parse `used_memory` / `maxmemory` out of `INFO memory`. */
export function redisMemory(info: string): { used: number; max: number } | null {
  const used = /^used_memory:(\d+)/m.exec(info)?.[1];
  const max = /^maxmemory:(\d+)/m.exec(info)?.[1];
  if (used === undefined || max === undefined) return null;
  return { used: Number(used), max: Number(max) };
}

/**
 * Health checks for `checks` in `config/telescope.ts`:
 *
 * ```ts
 * import { checks, defineConfig } from '@adonis-agora/telescope'
 *
 * export default defineConfig({
 *   checks: [
 *     checks.redis(),
 *     checks.lucid({ connection: 'pg' }),
 *     checks.custom('stripe', async () => ({ status: 'ok' })),
 *   ],
 * })
 * ```
 */
export const checks = {
  /** `PING`, a short-lived write and `INFO memory` on an `@adonisjs/redis` connection. */
  redis(options: RedisCheckOptions = {}): TelescopeCheck {
    const write = options.write !== false;
    const warnRatio = options.memoryWarnRatio ?? 0.9;
    const label = options.connection ?? 'default';
    return {
      ...base(options.connection ? `redis:${options.connection}` : 'redis', options),
      async run(ctx) {
        const redis = (await ctx.make('redis')) as {
          connection(name?: string): RedisConnectionLike;
        };
        const connection = redis.connection(options.connection);
        await connection.ping();
        if (write && typeof connection.set === 'function') {
          // A Redis at maxmemory with `noeviction` still answers PING; a write is what fails.
          await connection.set(`telescope:health:${randomUUID()}`, '1', 'PX', 10_000);
        }
        if (typeof connection.info === 'function') {
          const memory = redisMemory(await connection.info('memory'));
          if (memory !== null && memory.max > 0) {
            const ratio = memory.used / memory.max;
            const meta = { usedMemory: memory.used, maxMemory: memory.max };
            if (ratio >= warnRatio) {
              return {
                status: 'warn',
                message: `memory at ${Math.round(ratio * 100)}% of maxmemory (${label})`,
                meta,
              };
            }
            return { status: 'ok', meta };
          }
        }
        return { status: 'ok' };
      },
    };
  },

  /** `SELECT 1` on an `@adonisjs/lucid` connection. */
  lucid(options: LucidCheckOptions = {}): TelescopeCheck {
    return {
      ...base(options.connection ? `db:${options.connection}` : 'db', options),
      async run(ctx) {
        const db = (await ctx.make('lucid.db')) as {
          connection(name?: string): { rawQuery(sql: string): Promise<unknown> };
        };
        await db.connection(options.connection).rawQuery('SELECT 1');
        return { status: 'ok' };
      },
    };
  },

  /**
   * A check of your own: `run` answers `{ status: 'ok' | 'warn' | 'down', message? }`, or throws
   * (a throw is `down` with the error's message).
   */
  custom(
    name: string,
    run: (ctx: CheckContext) => Promise<CheckOutcome> | CheckOutcome,
    options: Omit<CheckOptions, 'name'> = {},
  ): TelescopeCheck {
    if (typeof name !== 'string' || name === '') {
      throw new Error('[@adonis-agora/telescope] checks.custom() needs a name');
    }
    return {
      ...base(name, options),
      critical: options.critical ?? true,
      run: async (ctx) => run(ctx),
    };
  },
};
