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

/**
 * The OpenTelemetry JS SDK line (`1`, `2`, `3`, …) a package version belongs to, or `null`.
 *
 * OTel JS ships two release trains that move together: the stable packages (`core`,
 * `sdk-trace-base`, …) use the line as their major, and the experimental packages (`sdk-node`,
 * `sdk-logs`, the OTLP exporters…) stay on `0.x` with the line encoded in the minor's hundreds:
 * stable `2.x` ↔ experimental `0.2xx` (e.g. `sdk-node@0.200.0` pins `core@2.0.0`), stable `3.x` ↔
 * experimental `0.3xx` (`sdk-node@0.300.0` pins `core@3.0.0`). Before 2.0 the experimental minors
 * were below 100 (`sdk-node@0.57.x` pins `core@1.30.x`), which is the 1.x line. Future lines follow
 * the same rule, so `0.4xx` is SDK 4.
 */
export function sdkLine(name: string, version: string): number | null {
  if (!name.startsWith('@opentelemetry/')) return null;
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 1) return major;
  // Experimental `0.x`: `0.Nxx` is line N from 2.0 on; anything below 0.100 is the 1.x line.
  return minor >= 200 ? Math.floor(minor / 100) : minor < 100 ? 1 : null;
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
 * `telescope.otel`: OpenTelemetry SDK packages from different major lines (e.g. SDK 2 and SDK 3)
 * mixed in one app (error: their providers do not interoperate), and two copies of `@opentelemetry/api` (warn: telescope would
 * emit into a global the app's SDK never reads). `@adonisjs/otel` 2 ships SDK 3.
 */
export function checkOtel(install: OtelInstall): AgoraDoctorResult[] {
  if (install.adonisOtel === null && install.sdk.length === 0 && install.apiFromApp === null) {
    return [{ status: 'skip', message: 'OpenTelemetry is not installed.' }];
  }
  const results: AgoraDoctorResult[] = [];
  const lines = new Map<number, string[]>();
  for (const pkg of install.sdk) {
    const line = sdkLine(pkg.name, pkg.version);
    if (line === null) continue;
    lines.set(line, [...(lines.get(line) ?? []), `${pkg.name}@${pkg.version} (${pkg.from})`]);
  }
  const adonisMajor = Number(/^(\d+)/.exec(install.adonisOtel ?? '')?.[1] ?? Number.NaN);
  if (adonisMajor === 2 && !lines.has(3)) lines.set(3, [`@adonisjs/otel@${install.adonisOtel}`]);
  if (lines.size > 1) {
    const sorted = [...lines.keys()].sort((a, b) => a - b);
    const described = sorted.map((line) => `SDK ${line} (${(lines.get(line) ?? []).join(', ')})`);
    results.push({
      status: 'error',
      message: `OpenTelemetry SDK lines are mixed: ${described.join(' next to ')}.`,
      fix:
        adonisMajor === 2
          ? 'Move every @opentelemetry SDK package to 3.x / 0.3xx (the line @adonisjs/otel 2 uses), or drop the others.'
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
    const [only] = lines.keys();
    const line = only === undefined ? 'the API only' : `SDK ${only}`;
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

/** The slice of the SQL store `telescope.db-schema` reads. */
export interface SchemaInspectable {
  inspectSchema(): Promise<{
    schema: string;
    exists: boolean;
    missingTables: string[];
    writeError: string | null;
  } | null>;
}

/** `telescope.db-schema`: the configured `schema` exists, holds the tables, and takes writes. */
export async function checkDbSchema(store: SchemaInspectable): Promise<AgoraDoctorResult[]> {
  const docs = `${DOCS}/packages/storages`;
  const found = await store.inspectSchema();
  if (found === null) return [];
  if (!found.exists) {
    return [
      {
        status: 'error',
        message: `The database schema "${found.schema}" does not exist (or this connection cannot see it).`,
        fix: `Run the telescope migration, or create it: CREATE SCHEMA "${found.schema}" on Postgres, CREATE DATABASE \`${found.schema}\` on MySQL.`,
        docs,
      },
    ];
  }
  const results: AgoraDoctorResult[] = [];
  if (found.missingTables.length > 0) {
    results.push({
      status: 'error',
      message: `Missing from schema "${found.schema}": ${found.missingTables.join(', ')}.`,
      fix: 'Run the telescope migration (node ace migration:run), or set autoCreateTable.',
      docs,
    });
  }
  if (found.writeError !== null) {
    results.push({
      status: 'error',
      message: `This connection cannot write to schema "${found.schema}": ${found.writeError.split('\n')[0]}`,
      fix: `Grant the app's role USAGE on the schema and INSERT, SELECT, DELETE on its tables.`,
      docs,
    });
  }
  if (results.length === 0) {
    results.push({
      status: 'ok',
      message: `Schema "${found.schema}" exists, holds telescope's tables and takes writes.`,
    });
  }
  return results;
}

/**
 * The `telescope.db-schema` check, registered at boot only when the SQL store has a `schema`
 * (so an app without one sees no new line). Deep: it queries the database.
 */
export function dbSchemaDoctorCheck(store: SchemaInspectable): AgoraDoctorCheck {
  return {
    id: 'telescope.db-schema',
    lib: 'telescope',
    title: 'Database schema is ready',
    cost: 'deep',
    run: () => checkDbSchema(store),
  };
}

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
