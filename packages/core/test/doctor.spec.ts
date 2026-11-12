import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorRegistry,
  registerDoctorChecks,
  runAgoraDoctor,
} from '../src/doctor/agora_doctor.js';
import {
  checkCsrf,
  checkGate,
  checkMcpGate,
  checkOtel,
  checkRetention,
  csrfBlocksPath,
  readOtelInstall,
  sdkLine,
  telescopeDoctorChecks,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';

const fixtureRoots: string[] = [];
afterAll(async () => {
  await Promise.all(fixtureRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const gate = { name: 'console', file: 'config/telescope_ui.ts', docs: 'https://x' };

/** An app rooted at a fixture dir with `node_modules/<name>/package.json` files. */
async function fixtureApp(
  packages: Record<string, { version: string; at?: string }>,
  config: Record<string, unknown> = {},
  inProduction = false,
): Promise<ApplicationService> {
  const root = await mkdtemp(join(tmpdir(), 'tel-doctor-'));
  fixtureRoots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  for (const [name, { version, at }] of Object.entries(packages)) {
    const dir = join(root, at ?? '', 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return {
    inProduction,
    nodeEnvironment: inProduction ? 'production' : 'development',
    makePath: (...parts: string[]) => join(root, ...parts),
    config: { get: (key: string, fallback?: unknown) => config[key] ?? fallback },
  } as unknown as ApplicationService;
}

describe('telescope doctor checks', () => {
  it('ids are frozen and all registered for --no-boot', () => {
    expect(telescopeDoctorChecks.map((c) => c.id)).toEqual([
      'telescope.console-gate',
      'telescope.mcp-gate',
      'telescope.mcp-csrf',
      'telescope.client-errors-csrf',
      'telescope.otel',
      'telescope.retention',
    ]);
    expect(agoraDoctorChecks).toBe(telescopeDoctorChecks);
    expect(new Set(telescopeDoctorChecks.map((c) => c.lib))).toEqual(new Set(['telescope']));
  });

  it('console gate: skip when absent/disabled, ok with authorize, warn in dev, error in prod', () => {
    expect(checkGate(undefined, true, gate).status).toBe('skip');
    expect(checkGate({ enabled: false }, true, gate).status).toBe('skip');
    expect(checkGate({ authorize: () => true }, true, gate).status).toBe('ok');
    expect(checkGate({}, false, gate).status).toBe('warn');
    const prod = checkGate({}, true, gate);
    expect(prod.status).toBe('error');
    expect(prod.fix).toContain('config/telescope_ui.ts');
  });

  it('CSRF probe: off, array and function exceptRoutes', () => {
    expect(csrfBlocksPath(undefined, '/telescope/mcp')).toBe(false);
    expect(csrfBlocksPath({ csrf: { enabled: false } }, '/telescope/mcp')).toBe(false);
    expect(csrfBlocksPath({ csrf: { enabled: true, methods: ['PUT'] } }, '/telescope/mcp')).toBe(
      false,
    );
    expect(csrfBlocksPath({ csrf: { enabled: true, methods: [] } }, '/telescope/mcp')).toBe(true); // shield: empty methods = every method
    expect(csrfBlocksPath({ csrf: { enabled: true } }, '/telescope/mcp')).toBe(true);
    expect(
      csrfBlocksPath(
        { csrf: { enabled: true, exceptRoutes: ['/telescope/mcp'] } },
        '/telescope/mcp',
      ),
    ).toBe(false);
    const fn = (ctx: unknown) =>
      (ctx as { request: { url(): string } }).request.url().startsWith('/api/');
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: fn } }, '/telescope/mcp')).toBe(
      true,
    );
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: fn } }, '/api/mcp')).toBe(false);
    const throwing = () => {
      throw new Error('needs a real ctx');
    };
    expect(
      csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: throwing } }, '/telescope/mcp'),
    ).toBe('unknown');
    expect(
      checkCsrf(
        { csrf: { enabled: true, exceptRoutes: throwing } },
        { path: '/telescope/mcp', enabled: true, name: 'MCP endpoint' },
      ).status,
    ).toBe('skip');

    const blocked = checkCsrf(
      { csrf: { enabled: true } },
      { path: '/telescope/mcp', enabled: true, name: 'MCP endpoint' },
    );
    expect(blocked.status).toBe('warn');
    expect(blocked.fix).toBe("Add '/telescope/mcp' to csrf.exceptRoutes in config/shield.ts.");
    expect(checkCsrf({}, { path: '/x', enabled: false, name: 'x' }).status).toBe('skip');
  });

  it('OTel: SDK 2 next to SDK 3 is an error; one line is ok; two api copies warn', () => {
    expect(sdkLine('@opentelemetry/sdk-trace-base', '2.2.0')).toBe(2);
    expect(sdkLine('@opentelemetry/sdk-logs', '0.205.0')).toBe(2);
    expect(sdkLine('@opentelemetry/sdk-logs', '3.1.0')).toBe(3);

    const mixed = checkOtel({
      adonisOtel: '2.0.0',
      sdk: [{ name: '@opentelemetry/sdk-trace-base', version: '2.1.0', from: 'app' }],
      apiFromApp: '/a',
      apiFromTelescope: '/a',
    });
    expect(mixed.map((r) => r.status)).toEqual(['error']);
    expect(mixed[0]?.message).toContain('@opentelemetry/sdk-trace-base@2.1.0');

    expect(
      checkOtel({
        adonisOtel: '2.0.0',
        sdk: [{ name: '@opentelemetry/sdk-trace', version: '3.1.0', from: '@adonisjs/otel' }],
        apiFromApp: '/a',
        apiFromTelescope: '/a',
      }).map((r) => r.status),
    ).toEqual(['ok']);

    expect(
      checkOtel({ adonisOtel: null, sdk: [], apiFromApp: '/a', apiFromTelescope: '/b' }).map(
        (r) => r.status,
      ),
    ).toEqual(['warn']);

    expect(
      checkOtel({ adonisOtel: null, sdk: [], apiFromApp: null, apiFromTelescope: null }),
    ).toEqual([{ status: 'skip', message: 'OpenTelemetry is not installed.' }]);
  });

  it('OTel: sdkLine maps the experimental 0.Nxx train to the stable N.x line (real versions)', () => {
    // Real pairs from the npm metadata: sdk-node@0.57.2 → core 1.30.1, 0.200.0 → 2.0.0,
    // 0.208.0 → 2.2.0, 0.300.0 → 3.0.0, 0.301.1 → 3.1.1.
    expect(sdkLine('@opentelemetry/sdk-node', '0.57.2')).toBe(1);
    expect(sdkLine('@opentelemetry/core', '1.30.1')).toBe(1);
    expect(sdkLine('@opentelemetry/sdk-node', '0.200.0')).toBe(2);
    expect(sdkLine('@opentelemetry/sdk-node', '0.208.0')).toBe(2);
    expect(sdkLine('@opentelemetry/core', '2.2.0')).toBe(2);
    expect(sdkLine('@opentelemetry/sdk-node', '0.300.0')).toBe(3);
    expect(sdkLine('@opentelemetry/sdk-node', '0.301.1')).toBe(3);
    expect(sdkLine('@opentelemetry/core', '3.1.1')).toBe(3);
    expect(sdkLine('@opentelemetry/sdk-logs', '0.301.0-rc.1')).toBe(3);
    // Future lines follow the same rule.
    expect(sdkLine('@opentelemetry/sdk-node', '0.400.0')).toBe(4);
    expect(sdkLine('@opentelemetry/core', '4.0.0')).toBe(4);
    expect(sdkLine('some-other-pkg', '0.301.1')).toBeNull();
    expect(sdkLine('@opentelemetry/core', 'workspace:*')).toBeNull();
  });

  it('OTel: @adonisjs/otel 2 with sdk-node 0.301.1 and core 3.1.1 is consistent', () => {
    const results = checkOtel({
      adonisOtel: '2.0.0',
      sdk: [
        { name: '@opentelemetry/sdk-node', version: '0.301.1', from: '@adonisjs/otel' },
        { name: '@opentelemetry/sdk-logs', version: '0.301.0', from: '@adonisjs/otel' },
        { name: '@opentelemetry/core', version: '3.1.1', from: 'app' },
      ],
      apiFromApp: '/a',
      apiFromTelescope: '/a',
    });
    expect(results).toEqual([{ status: 'ok', message: 'OpenTelemetry is consistent (SDK 3).' }]);

    const mixed = checkOtel({
      adonisOtel: '2.0.0',
      sdk: [
        { name: '@opentelemetry/sdk-node', version: '0.301.1', from: '@adonisjs/otel' },
        { name: '@opentelemetry/sdk-logs', version: '0.208.0', from: 'app' },
      ],
      apiFromApp: '/a',
      apiFromTelescope: '/a',
    });
    expect(mixed.map((r) => r.status)).toEqual(['error']);
    expect(mixed[0]?.message).toBe(
      'OpenTelemetry SDK lines are mixed: SDK 2 (@opentelemetry/sdk-logs@0.208.0 (app)) next to SDK 3 (@opentelemetry/sdk-node@0.301.1 (@adonisjs/otel)).',
    );
  });

  it('OTel install is read from the app root and from @adonisjs/otel', async () => {
    const app = await fixtureApp({
      '@adonisjs/otel': { version: '2.0.0' },
      '@opentelemetry/sdk-trace-base': { version: '2.2.0' },
      '@opentelemetry/sdk-metrics': { version: '3.1.0', at: 'node_modules/@adonisjs/otel' },
    });
    const install = await readOtelInstall(app);
    expect(install.adonisOtel).toBe('2.0.0');
    expect(install.sdk.map((p) => `${p.name}@${p.version}:${p.from}`).sort()).toEqual([
      '@opentelemetry/sdk-metrics@3.1.0:@adonisjs/otel',
      '@opentelemetry/sdk-trace-base@2.2.0:app',
    ]);
    expect(checkOtel(install)[0]?.status).toBe('error');
  });

  it('retention: memory ok, a real store without prune warns in production only', () => {
    expect(checkRetention(undefined, true).status).toBe('ok');
    expect(checkRetention({ store: 'lucid' }, true).status).toBe('warn');
    expect(checkRetention({ store: 'lucid' }, false).status).toBe('ok');
    expect(checkRetention({ store: 'lucid', prune: { after: '7d' } }, true).status).toBe('ok');
    expect(checkRetention({ store: 'lucid', prune: { enabled: false } }, true).status).toBe('warn');
    expect(checkRetention({ enabled: false }, true).status).toBe('skip');
  });
});

describe('telescope.mcp-gate', () => {
  const run = (config: unknown, inProduction: boolean) =>
    telescopeDoctorChecks
      .find((c) => c.id === 'telescope.mcp-gate')!
      .run({
        inProduction,
        config: { get: (k: string) => (k === 'telescope_mcp' ? config : undefined) },
      } as never);

  it('skips, pointing to /mcp/agora, while the standalone endpoint is off (the default)', async () => {
    for (const config of [undefined, {}, { enabled: false }, { authorize: () => true }]) {
      const result = await run(config, true);
      expect(result).toMatchObject({ status: 'skip' });
      expect((result as { message: string }).message).toContain('/mcp/agora');
    }
  });

  it('evaluates the gate once enabled', async () => {
    expect(checkMcpGate({ enabled: true }, true).status).toBe('error');
    expect(checkMcpGate({ enabled: true }, false).status).toBe('warn');
    expect(checkMcpGate({ enabled: true, authorize: () => true }, true).status).toBe('ok');
  });

  it('mcp-csrf skips while the endpoint is off', async () => {
    const csrf = telescopeDoctorChecks.find((c) => c.id === 'telescope.mcp-csrf')!;
    const app = {
      inProduction: true,
      config: {
        get: (k: string) =>
          k === 'telescope_mcp' ? {} : k === 'shield' ? { csrf: { enabled: true } } : undefined,
      },
    } as never;
    expect(await csrf.run(app)).toMatchObject({ status: 'skip' });
  });
});

describe('agora:doctor with telescope', () => {
  it('registers into a shared registry and reports through the runner (exit codes)', async () => {
    const values = new Map<string, unknown>();
    const container = {
      hasBinding: (k: string) => values.has(k),
      bindValue: (k: string, v: unknown) => values.set(k, v),
      make: async (k: string) => values.get(k),
    };
    await registerDoctorChecks(container, telescopeDoctorChecks);
    await registerDoctorChecks(container, telescopeDoctorChecks);
    const registry = values.get(AGORA_DOCTOR_BINDING) as AgoraDoctorRegistry;
    expect(registry.checks).toHaveLength(telescopeDoctorChecks.length);

    const app = await fixtureApp(
      { '@adonis-agora/telescope': { version: '1.0.0-rc.3' } },
      {
        telescope_ui: {},
        telescope_mcp: { enabled: true, authorize: () => true },
        shield: { csrf: { enabled: true } },
      },
      true,
    );
    const { report, exitCode } = await runAgoraDoctor(app, registry.checks, {
      libs: ['telescope'],
    });
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
    expect(byId['telescope.console-gate']).toBe('error');
    expect(byId['telescope.mcp-gate']).toBe('ok');
    expect(byId['telescope.mcp-csrf']).toBe('warn');
    expect(exitCode).toBe(1);
  });
});

describe('agora-doctor copies', () => {
  it('are the canonical v1 files, checked in CI', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['check:agora-doctor']).toBe('node ../../scripts/check-agora-doctor.mjs .');
    expect(pkg.exports['./doctor']).toBeDefined();
    expect(pkg.exports['./commands']).toBeDefined();
    const runner = await readFile(
      new URL('../src/doctor/agora_doctor.ts', import.meta.url),
      'utf8',
    );
    expect(runner.startsWith('// agora-doctor runner v1')).toBe(true);
  });
});

describe('commands barrel', () => {
  it('lists agora:doctor and telescope:doctor', async () => {
    const { getMetaData } = await import('../commands/main.js');
    const names = (await getMetaData()).map((c: { commandName: string }) => c.commandName);
    expect(names).toEqual(['agora:doctor', 'telescope:doctor']);
  });
});
