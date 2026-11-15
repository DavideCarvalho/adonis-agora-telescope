import { describe, expect, it } from 'vitest';
import {
  checks,
  defineConfig,
  HealthChecks,
  liveness,
  readiness,
  redisMemory,
  resolveConfig,
} from '../../src/index.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('health checks', () => {
  it('reuses a result for cacheFor (default 30s), then runs again', async () => {
    const time = clock();
    let runs = 0;
    const set = new HealthChecks(
      [checks.custom('stripe', async () => ({ status: runs++ === 0 ? 'ok' : 'down' }))],
      { now: time.now },
    );
    expect((await set.run())[0]?.status).toBe('ok');
    time.advance(29_000);
    expect((await set.run())[0]?.status).toBe('ok');
    expect(runs).toBe(1);
    time.advance(2_000);
    const [state] = await set.run();
    expect(runs).toBe(2);
    expect(state?.status).toBe('down');
    expect(state?.since).toBe(time.now());
  });

  it('honours a custom cacheFor', async () => {
    const time = clock();
    let runs = 0;
    const set = new HealthChecks(
      [
        checks.custom(
          'x',
          () => {
            runs += 1;
            return { status: 'ok' };
          },
          { cacheFor: '5s' },
        ),
      ],
      { now: time.now },
    );
    await set.run();
    time.advance(6_000);
    await set.run();
    expect(runs).toBe(2);
  });

  it('shares one run between concurrent callers (single-flight)', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const set = new HealthChecks([
      checks.custom('db', async () => {
        runs += 1;
        await gate;
        return { status: 'ok' };
      }),
    ]);
    const all = Promise.all([set.run(), set.run(), set.report(), set.run()]);
    release();
    await all;
    expect(runs).toBe(1);
  });

  it('keeps `since` while the status does not change', async () => {
    const time = clock();
    const set = new HealthChecks(
      [checks.custom('q', () => ({ status: 'down' }), { cacheFor: 1 })],
      {
        now: time.now,
      },
    );
    const first = (await set.run())[0];
    time.advance(60_000);
    const later = (await set.run())[0];
    expect(later?.since).toBe(first?.since);
    expect(later?.checkedAt).toBe(time.now());
  });

  it('a throw or a timeout is down, with the reason', async () => {
    const set = new HealthChecks([
      checks.custom('boom', () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      }),
      checks.custom('slow', () => new Promise(() => {}), { timeout: 20 }),
    ]);
    const [boom, slow] = await set.run();
    expect(boom).toMatchObject({ status: 'down', message: 'ECONNREFUSED 127.0.0.1:6379' });
    expect(slow).toMatchObject({ status: 'down', message: 'timed out after 20 ms' });
  });

  it('accepts @adonisjs/core/health checks (warning → warn, error → down, cacheDuration in seconds)', async () => {
    const time = clock();
    let runs = 0;
    class DiskSpaceCheck {
      name = 'Disk space check';
      cacheDuration = 10;
      cacheFor() {
        return this;
      }
      async run() {
        runs += 1;
        return { status: runs === 1 ? 'warning' : 'error', message: 'disk 91% full' };
      }
    }
    const set = new HealthChecks([new DiskSpaceCheck()], { now: time.now });
    expect((await set.run())[0]).toMatchObject({ status: 'warn', message: 'disk 91% full' });
    time.advance(9_000);
    await set.run();
    expect(runs).toBe(1);
    time.advance(2_000);
    expect((await set.run())[0]?.status).toBe('down');
  });

  it('report(): down only for a critical check; a non-critical down is a warn', async () => {
    const soft = new HealthChecks([
      checks.custom('a', () => ({ status: 'ok' })),
      checks.custom('b', () => ({ status: 'down' }), { critical: false }),
    ]);
    expect((await soft.report()).status).toBe('warn');
    const hard = new HealthChecks([checks.custom('b', () => ({ status: 'down' }))]);
    expect((await hard.report()).status).toBe('down');
  });

  it('refuses two checks with one name, and junk, at defineConfig', () => {
    expect(() =>
      defineConfig({
        checks: [
          checks.custom('x', () => ({ status: 'ok' })),
          checks.custom('x', () => ({ status: 'ok' })),
        ],
      }),
    ).toThrow(/two checks are named "x"/);
    expect(() => defineConfig({ checks: [{} as never] })).toThrow(/checks.redis\(\)/);
    expect(resolveConfig({}).checks).toEqual([]);
  });
});

describe('checks.redis()', () => {
  function redisApp(connection: Record<string, unknown>) {
    const asked: Array<string | undefined> = [];
    return {
      asked,
      make: async (binding: string) => {
        expect(binding).toBe('redis');
        return {
          connection: (name?: string) => {
            asked.push(name);
            return connection;
          },
        };
      },
    };
  }

  it('is ok when PING, a write and memory are fine', async () => {
    const app = redisApp({
      ping: async () => 'PONG',
      set: async () => 'OK',
      info: async () => 'used_memory:100\r\nmaxmemory:1000\r\n',
    });
    const set = new HealthChecks([checks.redis({ connection: 'main' })], { make: app.make });
    const [state] = await set.run();
    expect(state).toMatchObject({
      name: 'redis:main',
      status: 'ok',
      meta: { usedMemory: 100, maxMemory: 1000 },
    });
    expect(app.asked).toEqual(['main']);
  });

  it('is down when PING answers but a write is refused (maxmemory with noeviction, #335)', async () => {
    const app = redisApp({
      ping: async () => 'PONG',
      set: async () => {
        throw new Error("OOM command not allowed when used memory > 'maxmemory'.");
      },
    });
    const [state] = await new HealthChecks([checks.redis()], { make: app.make }).run();
    expect(state).toMatchObject({ name: 'redis', status: 'down' });
    expect(state?.message).toMatch(/OOM command not allowed/);
  });

  it('warns near maxmemory', async () => {
    const app = redisApp({
      ping: async () => 'PONG',
      set: async () => 'OK',
      info: async () => 'used_memory:950\nmaxmemory:1000\n',
    });
    const [state] = await new HealthChecks([checks.redis()], { make: app.make }).run();
    expect(state).toMatchObject({
      status: 'warn',
      message: 'memory at 95% of maxmemory (default)',
    });
  });

  it('parses INFO memory', () => {
    expect(redisMemory('# Memory\r\nused_memory:12\r\nmaxmemory:0\r\n')).toEqual({
      used: 12,
      max: 0,
    });
    expect(redisMemory('nothing')).toBeNull();
  });
});

describe('checks.lucid()', () => {
  it('runs SELECT 1 on the connection, down when it throws', async () => {
    const sql: string[] = [];
    let fail = false;
    const make = async (binding: string) => {
      expect(binding).toBe('lucid.db');
      return {
        connection: (name?: string) => ({
          rawQuery: async (q: string) => {
            sql.push(`${name}:${q}`);
            if (fail) throw new Error('Connection terminated unexpectedly');
            return [];
          },
        }),
      };
    };
    const set = new HealthChecks([checks.lucid({ connection: 'pg', cacheFor: 1 })], { make });
    expect((await set.run())[0]).toMatchObject({ name: 'db:pg', status: 'ok' });
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    expect((await set.run())[0]).toMatchObject({
      status: 'down',
      message: 'Connection terminated unexpectedly',
    });
    expect(sql).toEqual(['pg:SELECT 1', 'pg:SELECT 1']);
  });
});

describe('probes', () => {
  it('readiness: 503 while a critical check is down or the instance drains, no messages', async () => {
    const down = new HealthChecks([
      checks.custom('redis', () => ({ status: 'down', message: 'secret host' })),
    ]);
    const answer = await readiness(down, 'ready');
    expect(answer).toEqual({
      status: 503,
      body: { status: 'down', checks: [{ name: 'redis', status: 'down' }] },
    });
    const ok = new HealthChecks([checks.custom('redis', () => ({ status: 'ok' }))]);
    expect((await readiness(ok, 'ready')).status).toBe(200);
    expect(await readiness(ok, 'draining')).toMatchObject({
      status: 503,
      body: { status: 'draining' },
    });
    expect((await readiness(null, null)).status).toBe(200);
  });

  it('liveness never runs the checks', () => {
    expect(liveness('ready')).toEqual({ status: 200, body: { status: 'ok' } });
    expect(liveness('draining').status).toBe(200);
  });

  it('health routes are validated', () => {
    expect(() => defineConfig({ health: { readiness: 'health' } })).toThrow(/starting with \//);
    expect(resolveConfig({ health: { readiness: '/health/ready' } }).health).toEqual({
      readiness: '/health/ready',
      liveness: null,
    });
  });
});
