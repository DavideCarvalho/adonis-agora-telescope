import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { getMetaData } from '../../commands/main.js';
import { shortDuration, TelescopeFleetList } from '../../commands/telescope_fleet.js';
import { defineConfig, type TelescopeConfig } from '../../src/define_config.js';
import { getTelescopeRuntime } from '../../src/registry.js';

let app: ApplicationService | null = null;
afterEach(async () => {
  await app?.terminate();
  app = null;
});

async function start(telescope: TelescopeConfig) {
  const ignitor = new IgnitorFactory()
    .merge({
      rcFileContents: { providers: [() => import('../../providers/telescope_provider.js')] },
      config: { telescope: defineConfig(telescope) },
    })
    .withCoreConfig()
    .withCoreProviders()
    .create(new URL('../tmp/', import.meta.url));
  app = ignitor.createApp('console') as ApplicationService;
  await app.init();
  await app.boot();
  return app;
}

type Ran = {
  exitCode?: number;
  ui: { logger: { getLogs(): Array<{ message: string }> } };
};
async function run(args: string[] = []): Promise<{ ran: Ran; out: string }> {
  const ace = await (app as ApplicationService).container.make('ace');
  const instance = (await ace.create(TelescopeFleetList as never, args)) as unknown as {
    ui: { switchMode(mode: 'raw'): void };
    exec(): Promise<unknown>;
  };
  instance.ui.switchMode('raw');
  await instance.exec();
  const ran = instance as unknown as Ran;
  return {
    ran,
    out: ran.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n'),
  };
}

async function seed() {
  const fleet = getTelescopeRuntime().fleet;
  const beat = (appName: string, id: string, version: string, bootedAgo: number) =>
    fleet?.beat(appName, {
      v: 1,
      instanceId: id,
      host: id,
      pid: 1,
      version,
      bootedAt: new Date(Date.now() - bootedAgo).toISOString(),
      sentAt: new Date().toISOString(),
      state: 'ready',
      intervalMs: 15_000,
      checks: [
        {
          name: 'redis',
          status: 'down',
          message: 'OOM',
          since: Date.now() - 12 * 60_000,
          checkedAt: Date.now(),
          durationMs: 1,
          critical: true,
        },
      ],
      shipping: null,
    });
  await beat('shop', 'web-1', 'v1', 3_600_000);
  await beat('shop', 'web-2', 'v2', 60_000);
  await beat('billing', 'b-1', 'v1', 3_600_000);
}

describe('telescope:fleet:list', () => {
  it('is registered as telescope:fleet:list', async () => {
    expect((await getMetaData()).map((c) => c.commandName)).toContain('telescope:fleet:list');
  });

  it('prints the console view as JSON, narrowed by --app', async () => {
    await start({});
    await seed();
    const { out, ran } = await run(['--json']);
    expect(ran.exitCode ?? 0).toBe(0);
    const body = JSON.parse(out);
    expect(body.data.apps.map((a: { app: string }) => a.app)).toEqual(['billing', 'shop']);
    const shop = body.data.apps[1];
    expect(shop.counts.up).toBe(2);
    expect(shop.deploys[0]).toMatchObject({ previous: 'v1', version: 'v2', live: 1, total: 2 });

    const narrowed = JSON.parse((await run(['--app', 'shop', '--json'])).out);
    expect(narrowed.data.apps.map((a: { app: string }) => a.app)).toEqual(['shop']);
  });

  it('prints tables, the deploys and the failing checks', async () => {
    await start({});
    await seed();
    const { out } = await run(['--app', 'shop']);
    expect(out).toContain('shop');
    expect(out).toContain('web-1');
    expect(out).toContain('deploy v1 → v2');
    expect(out).toMatch(/redis: down for 12m on 2 of 2 \(OOM\)/);
  });

  it('exits 1 when this telescope keeps no fleet', async () => {
    await start({ fleet: false });
    const { ran, out } = await run();
    expect(ran.exitCode).toBe(1);
    expect(out).toMatch(/keeps no fleet/);
  });

  it('formats durations', () => {
    expect(shortDuration(40_000)).toBe('40s');
    expect(shortDuration(12 * 60_000)).toBe('12m');
    expect(shortDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(shortDuration(50 * 3_600_000)).toBe('2d 2h');
  });
});
