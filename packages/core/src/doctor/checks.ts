import type { ApplicationService } from '@adonisjs/core/types';
import {
  type AgoraDoctorCheck,
  type AgoraDoctorResult,
  installedVersion,
  packageDir,
} from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/telescope';
const PKG = '@adonis-agora/telescope';

type AnyConfig = Record<string, unknown>;

/** `telescope.console-gate` / `telescope.mcp-gate`: a console with no `authorize`. */
export function checkGate(
  config: AnyConfig | undefined,
  inProduction: boolean,
  what: { name: string; file: string; docs: string },
): AgoraDoctorResult {
  if (config === undefined) {
    return {
      status: 'skip',
      message: `${what.file} is not present: the ${what.name} is not set up.`,
    };
  }
  if (config.enabled === false) return { status: 'skip', message: `The ${what.name} is disabled.` };
  if (config.authorize !== undefined) {
    return { status: 'ok', message: `The ${what.name} has an authorize.` };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message: inProduction
      ? `The ${what.name} has no authorize: it denies every request in production.`
      : `The ${what.name} has no authorize: it is open here and denies every request in production.`,
    fix: `Set \`authorize\` in ${what.file} (for example authorizeByToken({ token: env.get('CONSOLE_TOKEN') })).`,
    docs: what.docs,
  };
}

/** The `csrf` block of `config/shield.ts`, duck-typed. */
interface ShieldCsrfLike {
  enabled?: boolean;
  methods?: string[];
  exceptRoutes?: string[] | ((ctx: unknown) => boolean);
}

/**
 * Whether shield's CSRF check would reject a bare `POST` to `path` (an MCP client or a beacon sends
 * no CSRF token): `false` when CSRF is off, `POST` is not in an explicit method list (an empty
 * `methods` is shield's default and checks every method), or `exceptRoutes` exempts the route (an array naming it, or a function answering `true` for
 * a minimal context of that request). `'unknown'` when that function throws on the minimal context.
 */
export function csrfBlocksPath(shield: unknown, path: string): boolean | 'unknown' {
  const csrf = (shield as { csrf?: ShieldCsrfLike } | undefined)?.csrf;
  if (csrf === undefined || csrf.enabled !== true) return false;
  if (
    Array.isArray(csrf.methods) &&
    csrf.methods.length > 0 &&
    !csrf.methods.some((m) => m.toUpperCase() === 'POST')
  ) {
    return false;
  }
  const pattern = path.startsWith('/') ? path : `/${path}`;
  const except = csrf.exceptRoutes;
  if (typeof except === 'function') {
    try {
      const probe = {
        request: { url: () => pattern, method: () => 'POST', header: () => undefined },
        route: { pattern },
      };
      return except(probe) !== true;
    } catch {
      return 'unknown';
    }
  }
  if (Array.isArray(except)) return !except.includes(pattern);
  return true;
}

/** `telescope.mcp-csrf` / `telescope.client-errors-csrf`: a POST endpoint shield's CSRF would reject. */
export function checkCsrf(
  shield: unknown,
  endpoint: { path: string; enabled: boolean; name: string },
): AgoraDoctorResult {
  if (!endpoint.enabled) return { status: 'skip', message: `The ${endpoint.name} is not mounted.` };
  const blocked = csrfBlocksPath(shield, endpoint.path);
  if (blocked === 'unknown') {
    return {
      status: 'skip',
      message: `Could not tell whether csrf.exceptRoutes exempts POST ${endpoint.path} (the function needs a real request).`,
    };
  }
  if (!blocked) {
    return { status: 'ok', message: `POST ${endpoint.path} passes shield's CSRF check.` };
  }
  return {
    status: 'warn',
    message: `Shield's CSRF check rejects POST ${endpoint.path}: the ${endpoint.name} cannot be reached.`,
    fix: `Add '${endpoint.path}' to csrf.exceptRoutes in config/shield.ts.`,
    docs: `${DOCS}/packages/mcp`,
  };
}

/** The OpenTelemetry SDK line a package version belongs to (`2` or `3`), or `null`. */
export function sdkLine(name: string, version: string): 2 | 3 | null {
  const major = Number(/^(\d+)/.exec(version)?.[1] ?? Number.NaN);
  const minor = Number(/^\d+\.(\d+)/.exec(version)?.[1] ?? Number.NaN);
  if (major === 2 || major === 3) return major;
  // The experimental packages (sdk-logs, sdk-node, otlp exporters…) were 0.2xx on the SDK 2 line.
  if (major === 0 && minor >= 200 && name.startsWith('@opentelemetry/')) return 2;
  return null;
}

/** The OTel SDK packages telescope compares (the API package `@opentelemetry/api` is separate). */
export const OTEL_SDK_PACKAGES = [
  '@opentelemetry/core',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-node',
  '@opentelemetry/context-async-hooks',
] as const;

/** What {@link checkOtel} reads (resolved from the app root, @adonisjs/otel, and telescope). */
export interface OtelInstall {
  /** `@adonisjs/otel` version, or `null` when it is not installed. */
  adonisOtel: string | null;
  /** Each SDK package found, with where it came from. */
  sdk: Array<{ name: string; version: string; from: string }>;
  /** Real paths of `@opentelemetry/api` as resolved from the app and from telescope. */
  apiFromApp: string | null;
  apiFromTelescope: string | null;
}

/**
 * `telescope.otel`: OpenTelemetry SDK 2 and SDK 3 packages mixed in one app (error: their
 * providers do not interoperate), and two copies of `@opentelemetry/api` (warn: telescope would
 * emit into a global the app's SDK never reads). `@adonisjs/otel` 2 ships SDK 3.
 */
export function checkOtel(install: OtelInstall): AgoraDoctorResult[] {
  if (install.adonisOtel === null && install.sdk.length === 0 && install.apiFromApp === null) {
    return [{ status: 'skip', message: 'OpenTelemetry is not installed.' }];
  }
  const results: AgoraDoctorResult[] = [];
  const lines = new Map<2 | 3, string[]>();
  for (const pkg of install.sdk) {
    const line = sdkLine(pkg.name, pkg.version);
    if (line === null) continue;
    lines.set(line, [...(lines.get(line) ?? []), `${pkg.name}@${pkg.version} (${pkg.from})`]);
  }
  const adonisMajor = Number(/^(\d+)/.exec(install.adonisOtel ?? '')?.[1] ?? Number.NaN);
  if (adonisMajor === 2 && !lines.has(3)) lines.set(3, [`@adonisjs/otel@${install.adonisOtel}`]);
  if (lines.has(2) && lines.has(3)) {
    results.push({
      status: 'error',
      message: `OpenTelemetry SDK 2 and SDK 3 are mixed: ${[...(lines.get(2) ?? [])].join(', ')} next to ${[...(lines.get(3) ?? [])].join(', ')}.`,
      fix:
        adonisMajor === 2
          ? 'Move every @opentelemetry SDK package to 3.x (the line @adonisjs/otel 2 uses), or drop the SDK 2 one.'
          : 'Keep every @opentelemetry SDK package on one major line.',
      docs: `${DOCS}/packages/otel`,
    });
  }
  if (
    install.apiFromApp !== null &&
    install.apiFromTelescope !== null &&
    install.apiFromApp !== install.apiFromTelescope
  ) {
    results.push({
      status: 'warn',
      message:
        'Two copies of @opentelemetry/api are installed (one for the app, one for telescope): telescope may emit into a global your SDK never reads.',
      fix: 'Dedupe @opentelemetry/api (one version for the whole app, e.g. a pnpm override).',
      docs: `${DOCS}/packages/otel`,
    });
  }
  if (results.length === 0) {
    const line = lines.has(3) ? 'SDK 3' : lines.has(2) ? 'SDK 2' : 'the API only';
    results.push({ status: 'ok', message: `OpenTelemetry is consistent (${line}).` });
  }
  return results;
}

/** `telescope.retention`: production with nothing pruning the entries. */
export function checkRetention(
  config: AnyConfig | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (config?.enabled === false) return { status: 'skip', message: 'Telescope is disabled.' };
  const store = config?.store ?? 'memory';
  if (store === 'memory') {
    return { status: 'ok', message: 'The memory store keeps a bounded ring of entries.' };
  }
  const prune = config?.prune as { enabled?: boolean } | undefined;
  if (prune !== undefined && prune !== null && prune.enabled !== false) {
    return { status: 'ok', message: 'A prune schedule is configured.' };
  }
  return {
    status: inProduction ? 'warn' : 'ok',
    message: inProduction
      ? 'No `prune` is configured: the entries table grows without bound.'
      : 'No `prune` is configured (fine outside production).',
    ...(inProduction
      ? { fix: "Set `prune: { after: '7d' }` (or your retention) in config/telescope.ts." }
      : {}),
    docs: `${DOCS}/concepts/protection`,
  };
}

/** Collect the OpenTelemetry install as seen from the app root. */
export async function readOtelInstall(app: ApplicationService): Promise<OtelInstall> {
  const root = app.makePath();
  const sdk: OtelInstall['sdk'] = [];
  const seen = new Set<string>();
  const scan = async (from: string, label: string) => {
    for (const name of OTEL_SDK_PACKAGES) {
      const dir = await packageDir(name, from);
      if (dir === null || seen.has(dir)) continue;
      seen.add(dir);
      const version = await installedVersion(name, from);
      if (version !== null) sdk.push({ name, version, from: label });
    }
  };
  await scan(root, 'app');
  const adonisOtelDir = await packageDir('@adonisjs/otel', root);
  if (adonisOtelDir !== null) await scan(adonisOtelDir, '@adonisjs/otel');
  const telescopeDir = await packageDir(PKG, root);
  return {
    adonisOtel: await installedVersion('@adonisjs/otel', root),
    sdk,
    apiFromApp: await packageDir('@opentelemetry/api', root),
    apiFromTelescope:
      telescopeDir === null ? null : await packageDir('@opentelemetry/api', telescopeDir),
  };
}

function path(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback;
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

const get = (app: ApplicationService, key: string) =>
  app.config.get<AnyConfig | undefined>(key, undefined);

/** Every telescope check (`register` + `--no-boot`). Ids are frozen for 1.x. */
export const telescopeDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'telescope.console-gate',
    lib: 'telescope',
    title: 'Console access in production',
    run: (app) =>
      checkGate(get(app, 'telescope_ui'), app.inProduction, {
        name: 'console',
        file: 'config/telescope_ui.ts',
        docs: `${DOCS}/dashboard/auth`,
      }),
  },
  {
    id: 'telescope.mcp-gate',
    lib: 'telescope',
    title: 'MCP endpoint access in production',
    run: (app) =>
      checkGate(get(app, 'telescope_mcp'), app.inProduction, {
        name: 'MCP endpoint',
        file: 'config/telescope_mcp.ts',
        docs: `${DOCS}/packages/mcp`,
      }),
  },
  {
    id: 'telescope.mcp-csrf',
    lib: 'telescope',
    title: 'MCP endpoint passes CSRF',
    run: (app) => {
      const mcp = get(app, 'telescope_mcp');
      return checkCsrf(get(app, 'shield'), {
        path: path(mcp?.path, '/telescope/mcp'),
        enabled: mcp !== undefined && mcp.enabled !== false,
        name: 'MCP endpoint',
      });
    },
  },
  {
    id: 'telescope.client-errors-csrf',
    lib: 'telescope',
    title: 'Client error ingestion passes CSRF',
    run: (app) => {
      const clientErrors = get(app, 'telescope')?.clientErrors as AnyConfig | undefined;
      return checkCsrf(get(app, 'shield'), {
        path: path(clientErrors?.path, '/telescope/client-errors'),
        enabled: clientErrors !== undefined && clientErrors.enabled === true,
        name: 'client error endpoint',
      });
    },
  },
  {
    id: 'telescope.otel',
    lib: 'telescope',
    title: 'OpenTelemetry packages line up',
    run: async (app) => checkOtel(await readOtelInstall(app)),
  },
  {
    id: 'telescope.retention',
    lib: 'telescope',
    title: 'Entries are pruned in production',
    run: (app) => checkRetention(get(app, 'telescope'), app.inProduction),
  },
];
