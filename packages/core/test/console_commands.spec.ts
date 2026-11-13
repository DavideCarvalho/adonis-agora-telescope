import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleCommands, getMetaData } from '../commands/main.js';
import {
  TelescopeEntriesClear,
  TelescopeEntriesExport,
  TelescopeEntriesList,
  TelescopeEntriesPrune,
  TelescopeEntriesShow,
} from '../commands/telescope_entries.js';
import {
  TelescopeExceptionsDiagnose,
  TelescopeExceptionsList,
  TelescopeMetricsShow,
  TelescopeOverviewShow,
  TelescopePulseShow,
  TelescopeRetentionShow,
  TelescopeScreensList,
  TelescopeTracesList,
  TelescopeTracesShow,
  TelescopeTracesWaterfall,
} from '../commands/telescope_metrics.js';
import {
  TelescopeExtAction,
  TelescopeJobsRetry,
  TelescopeMetaShow,
  TelescopeProfilesStatus,
  TelescopeQueuesList,
  TelescopeRequestsReplay,
  TelescopeSchedulesList,
  TelescopeTenantsList,
} from '../commands/telescope_ops.js';
import { defineConfig } from '../src/define_config.js';
import { getTelescopeRuntime } from '../src/registry.js';

/** The `telescope:*` console commands through the real ace kernel of a booted app. */
describe('console commands', () => {
  let app: ApplicationService;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'telescope-cli-'));
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../providers/telescope_provider.js')] },
        config: { telescope: defineConfig({ store: 'memory', prune: { after: '1h' } }) },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    await app.boot();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  type Ran = {
    exitCode?: number;
    ui: { logger: { getLogs(): Array<{ message: string }> } };
    assertSucceeded(): void;
    assertFailed(): void;
  };
  async function run(command: unknown, args: string[] = []): Promise<Ran> {
    const ace = await app.container.make('ace');
    const instance = (await ace.create(command as never, args)) as unknown as {
      ui: { switchMode(mode: 'raw'): void };
      exec(): Promise<unknown>;
    };
    instance.ui.switchMode('raw');
    await instance.exec();
    return instance as unknown as Ran;
  }
  const logs = (command: Ran) =>
    command.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  const json = async (command: unknown, args: string[] = []) => {
    const ran = await run(command, [...args, '--json']);
    ran.assertSucceeded();
    return JSON.parse(logs(ran));
  };
  const store = () => getTelescopeRuntime().store!;
  async function seed() {
    const a = await store().record({
      type: 'request',
      content: { method: 'GET', url: '/a', status: 200 },
      tags: ['status:200'],
      traceId: 't1',
      durationMs: 12,
    });
    const b = await store().record({
      type: 'query',
      content: { sql: 'select 1' },
      tags: [],
      traceId: 't1',
      durationMs: 2,
    });
    const c = await store().record({
      type: 'exception',
      content: { name: 'Error', message: 'boom' },
      tags: ['status:500'],
      familyHash: 'Error:boom',
      traceId: 't2',
    });
    return { a, b, c };
  }

  it('registers every console command as telescope:<noun>:<verb>', async () => {
    const names = (await getMetaData()).map((c) => c.commandName);
    expect(names).toEqual(
      expect.arrayContaining(['agora:doctor', 'telescope:doctor', 'telescope:entries:list']),
    );
    for (const command of consoleCommands) {
      expect(command.commandName).toMatch(/^telescope:[a-z-]+:[a-z-]+$/);
    }
  });

  it('lists entries in the console envelope, filtered and cursor-paged', async () => {
    await seed();
    const all = await json(TelescopeEntriesList);
    expect(all.data).toHaveLength(3);
    expect(all.meta).toMatchObject({ hasNext: false, nextCursor: null });
    expect(all.data[0]).toMatchObject({ type: 'exception', summary: 'boom' });

    const requests = await json(TelescopeEntriesList, ['--type', 'request']);
    expect(requests.data.map((e: { type: string }) => e.type)).toEqual(['request']);

    const tagged = await json(TelescopeEntriesList, ['--tag', 'status:500', '--tag', 'status:200']);
    expect(tagged.data).toHaveLength(2);

    const first = await json(TelescopeEntriesList, ['--first', '2']);
    expect(first.data).toHaveLength(2);
    expect(first.meta.hasNext).toBe(true);
    const next = await json(TelescopeEntriesList, [
      '--first',
      '2',
      '--after',
      first.meta.nextCursor,
    ]);
    expect(next.data).toHaveLength(1);

    const recent = await json(TelescopeEntriesList, ['--since', '1h']);
    expect(recent.data).toHaveLength(3);
    const none = await json(TelescopeEntriesList, ['--until', '1h']);
    expect(none.data).toHaveLength(0);
  });

  it('renders a table by default and refuses bad input with exit code 1', async () => {
    await seed();
    const table = await run(TelescopeEntriesList);
    table.assertSucceeded();
    expect(logs(table)).toContain('GET /a → 200');

    const badCursor = await run(TelescopeEntriesList, ['--after', 'nope']);
    badCursor.assertFailed();
    expect(badCursor.exitCode).toBe(1);

    const badSince = await run(TelescopeEntriesList, ['--since', 'yesterday-ish']);
    badSince.assertFailed();
    expect(logs(badSince)).toContain('--since');
  });

  it('shows one entry with its trace siblings, 404 when it is gone', async () => {
    const { a, b } = await seed();
    const shown = await json(TelescopeEntriesShow, [a.id]);
    expect(shown.data).toMatchObject({ id: a.id, content: { url: '/a' } });
    expect(shown.trace.map((e: { id: string }) => e.id)).toEqual([b.id]);

    const missing = await run(TelescopeEntriesShow, ['nope']);
    missing.assertFailed();
    expect(logs(missing)).toContain('404: Entry not found');
  });

  it('exports filtered entries as CSV to a file', async () => {
    await seed();
    const file = join(dir, 'out.csv');
    const ran = await run(TelescopeEntriesExport, ['--format', 'csv', '--output', file]);
    ran.assertSucceeded();
    const lines = readFileSync(file, 'utf8').split('\r\n');
    expect(lines[0]).toBe('id,type,createdAt,durationMs,tags,familyHash,traceId,summary');
    expect(lines).toHaveLength(4);

    const limited = await run(TelescopeEntriesExport, ['--limit', '1']);
    limited.assertSucceeded();
    expect(JSON.parse(logs(limited))).toHaveLength(1);

    const bad = await run(TelescopeEntriesExport, ['--format', 'xml']);
    bad.assertFailed();
  });

  it('reads traces, a trace, and its waterfall', async () => {
    await seed();
    const traces = await json(TelescopeTracesList);
    expect(traces.data.length).toBe(2);
    expect(traces.meta).toHaveProperty('hasNext');

    const trace = await json(TelescopeTracesShow, ['t1']);
    expect(trace.meta).toEqual({ traceId: 't1', count: 2 });

    const waterfall = await json(TelescopeTracesWaterfall, ['t1']);
    expect(waterfall.meta).toEqual({ traceId: 't1' });
    const missing = await run(TelescopeTracesWaterfall, ['nope']);
    missing.assertFailed();
    expect(logs(missing)).toContain('404');
  });

  it('reads the overview, pulse, metrics, screens, exceptions and retention', async () => {
    await seed();
    const overview = await json(TelescopeOverviewShow);
    expect(overview.data.count).toBe(3);
    expect(await json(TelescopePulseShow, ['--window', '1h'])).toHaveProperty('data');
    expect(await json(TelescopeMetricsShow, ['--type', 'request'])).toHaveProperty('data');
    expect(await json(TelescopeScreensList)).toHaveProperty('meta');
    expect(await json(TelescopeExceptionsList, ['--window', '1d'])).toHaveProperty('data');
    const retention = await json(TelescopeRetentionShow);
    expect(retention.data).toMatchObject({ enabled: true, afterMs: 3_600_000 });

    // Human output renders without --json.
    (await run(TelescopePulseShow)).assertSucceeded();
    (await run(TelescopeOverviewShow)).assertSucceeded();
  });

  it('keeps the console gates: AI, replay, queues and profiling off answer as the console does', async () => {
    const { a, c } = await seed();
    const diagnose = await run(TelescopeExceptionsDiagnose, [c.id]);
    diagnose.assertFailed();
    expect(logs(diagnose)).toContain('404: AI diagnosis is not configured');

    const replay = await run(TelescopeRequestsReplay, [a.id, '--force']);
    replay.assertFailed();
    expect(logs(replay)).toContain('403: Request replay is disabled');

    const retry = await run(TelescopeJobsRetry, ['default', '1', '--force']);
    retry.assertFailed();
    expect(logs(retry)).toContain('403: Queue actions are disabled');

    const queues = await run(TelescopeQueuesList);
    queues.assertFailed();
    expect(logs(queues)).toContain('404');

    (await run(TelescopeProfilesStatus)).assertFailed();
    const action = await run(TelescopeExtAction, ['x', 'y', '--force']);
    action.assertFailed();
    expect(logs(action)).toContain('No telescope extension');
  });

  it('describes what is on, the schedules and the organizations', async () => {
    const meta = await json(TelescopeMetaShow);
    expect(meta.data).toMatchObject({ ai: { enabled: false }, queueManager: { enabled: false } });
    expect(await json(TelescopeSchedulesList)).toEqual({ data: { tasks: [] } });
    expect((await json(TelescopeTenantsList)).data.enabled).toBe(false);

    const tenant = await run(TelescopeEntriesList, ['--tenant', 'acme']);
    tenant.assertFailed();
    expect(logs(tenant)).toContain('--tenant needs tenancy');
  });

  it('prunes: --dry-run counts, no --force refuses without a terminal, --force deletes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 3 * 3_600_000));
    await seed();
    vi.useRealTimers();
    await store().record({ type: 'log', content: { message: 'fresh' }, tags: [] });

    const dry = await json(TelescopeEntriesPrune, ['--dry-run']);
    expect(dry).toMatchObject({ dryRun: true, olderThanCutoff: 3, capped: false });
    expect(await store().count()).toBe(4);

    const refused = await run(TelescopeEntriesPrune, []);
    refused.assertFailed();
    expect(logs(refused)).toContain('pass --force');
    expect(await store().count()).toBe(4);

    const scoped = await run(TelescopeEntriesPrune, ['--tenant', 'acme', '--force']);
    scoped.assertFailed();

    const pruned = await json(TelescopeEntriesPrune, ['--older-than', '2h', '--force']);
    expect(pruned.deleted).toBe(3);
    expect(await store().count()).toBe(1);
  });

  it('clears every entry only with --force', async () => {
    await seed();
    (await run(TelescopeEntriesClear)).assertFailed();
    expect(await store().count()).toBe(3);
    expect(await json(TelescopeEntriesClear, ['--force'])).toEqual({ cleared: true });
    expect(await store().count()).toBe(0);
  });
});
