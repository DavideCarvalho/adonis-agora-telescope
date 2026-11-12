import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorRegistry,
  registerDoctorChecks,
  runAgoraDoctor,
} from '../src/doctor/agora_doctor.js';
import {
  checkCsrf,
  checkGate,
  checkOtel,
  checkRetention,
  csrfBlocksPath,
  readOtelInstall,
  sdkLine,
  telescopeDoctorChecks,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';

const gate = { name: 'console', file: 'config/telescope_ui.ts', docs: 'https://x' };

/** An app rooted at a fixture dir with `node_modules/<name>/package.json` files. */
async function fixtureApp(
  packages: Record<string, { version: string; at?: string }>,
  config: Record<string, unknown> = {},
  inProduction = false,
): Promise<ApplicationService> {
  const root = await mkdtemp(join(tmpdir(), 'tel-doctor-'));
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
    ).toBe(false);

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
        telescope_mcp: { authorize: () => true },
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
  it('ship the runner and the command as reference text in dist', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['copy:stubs']).toContain('dist/agora-doctor/agora_doctor.ts.txt');
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
