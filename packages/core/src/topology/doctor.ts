import type { ApplicationService } from '@adonisjs/core/types';
import type { AgoraDoctorCheck, AgoraDoctorResult } from '../doctor/agora_doctor.js';
import { getTelescopeRuntime } from '../registry.js';
import { describeTenantProvenance, tenantProvenance } from './auto_tenant.js';
import {
  type ResolvedTopology,
  resolveIngestLimits,
  resolveTopology,
  serverPrefix,
} from './config.js';
import { activeRemoteStores } from './remote_store.js';
import { httpServer, whoami } from './status.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/telescope/concepts/central-server';
const TRANSPORT_DOCS = 'https://davidecarvalho.github.io/agora/docs/telescope/concepts/transports';

type Read =
  | { config: Record<string, unknown> | undefined; topology: ResolvedTopology }
  | AgoraDoctorResult;

/** `config/telescope.ts` and its resolved topology, or the result to report instead. */
function read(app: ApplicationService): Read {
  let config: Record<string, unknown> | undefined;
  // `--no-boot` never loads the config: every check must skip, not throw.
  try {
    config = app.config?.get?.<Record<string, unknown> | undefined>('telescope', undefined);
  } catch {
    return {
      status: 'skip',
      message: 'The app is not booted: run without `--no-boot` to check the telescope topology.',
    };
  }
  try {
    return { config, topology: resolveTopology(config ?? {}) };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      fix: "Fix topology, verifyTenant or tenant in config/telescope.ts (a tenant's url, token and partition can come from @adonis-agora/authkit-client's `service`).",
      docs: DOCS,
    };
  }
}

const isResult = (value: Read): value is AgoraDoctorResult => 'status' in value;
const skip = (message: string): AgoraDoctorResult => ({ status: 'skip', message });

/**
 * For Shield's `csrf.exceptRoutes` on a control plane: whether `url` is one of its ingest routes
 * (apps post without a CSRF token).
 */
export function telescopeCsrfExceptions(url: string, path = '/_telescope/v1'): boolean {
  const prefix = resolveIngestLimits({ path }).path;
  const pathname = url.split('?')[0] ?? url;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether Shield's CSRF lets a `POST` to `url` through. `csrf` is `config/shield.ts`'s `csrf`
 * block; no block, or `enabled: false`, lets it through.
 */
export function csrfExempts(csrf: unknown, url: string): boolean {
  if (csrf === null || typeof csrf !== 'object') return true;
  const config = csrf as { enabled?: unknown; exceptRoutes?: unknown };
  if (config.enabled === false) return true;
  const except = config.exceptRoutes;
  if (Array.isArray(except)) return except.some((route) => route === url);
  if (typeof except === 'function') {
    try {
      return (
        (except as (ctx: unknown) => unknown)({
          request: { url: () => url, method: () => 'POST', header: () => undefined },
          route: { pattern: url },
        }) === true
      );
    } catch {
      return false;
    }
  }
  return false;
}

/** The topology checks `agora:doctor` runs (part of the telescope checks). */
export const topologyDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'telescope.topology',
    lib: 'telescope',
    title: 'Topology',
    run: (app) => {
      const state = read(app);
      if (isResult(state)) return state;
      const { topology } = state;
      if (topology.topology === 'standalone') {
        return skip('Standalone: this app keeps its own telescope entries.');
      }
      if (topology.topology === 'tenant') {
        const server = httpServer(topology);
        const where =
          server === null
            ? `over ${topology.transport.describe()}`
            : server.current !== null
              ? `to ${serverPrefix(server.current)}`
              : 'to the server tenant.url resolves (looked up on first send)';
        return {
          status: 'ok',
          message: `Sends entries as app ${JSON.stringify(topology.tenant.partition)} ${where}.`,
        };
      }
      return {
        status: 'ok',
        message: `Receives entries on POST ${topology.ingest.path}/ingest${topology.transport !== null ? ` and from ${topology.transport.describe()}` : ''}.`,
      };
    },
  },
  {
    id: 'telescope.tenant-source',
    lib: 'telescope',
    title: 'Tenant settings',
    run: (app) => {
      const state = read(app);
      if (isResult(state)) return state;
      if (state.topology.topology !== 'tenant') return skip('Not a tenant.');
      return {
        status: 'ok',
        message: `${describeTenantProvenance(tenantProvenance(state.config ?? {}))}.`,
      };
    },
  },
  {
    id: 'telescope.topology-store',
    lib: 'telescope',
    title: 'Where entries go',
    run: (app) => {
      const state = read(app);
      if (isResult(state)) return state;
      const { config, topology } = state;
      if (topology.topology === 'standalone') return skip('Standalone: nothing to send.');
      const disabled = config?.enabled === false;
      if (topology.topology === 'control-plane') {
        return getTelescopeRuntime().store !== null
          ? { status: 'ok', message: "Received entries are written to this server's store." }
          : {
              status: 'error',
              message:
                'Telescope is not running on this server: received entries cannot be stored.',
              fix: disabled
                ? 'Remove `enabled: false` from config/telescope.ts.'
                : 'Register @adonis-agora/telescope/telescope_provider in adonisrc.ts.',
              docs: DOCS,
            };
      }
      return activeRemoteStores.size > 0
        ? { status: 'ok', message: 'Entries are sent to the server in the background.' }
        : {
            status: 'warn',
            message: 'Telescope is not running here: this app sends nothing to the server.',
            fix: disabled
              ? 'Remove `enabled: false` from config/telescope.ts.'
              : 'Register @adonis-agora/telescope/telescope_provider in adonisrc.ts.',
            docs: DOCS,
          };
    },
  },
  {
    id: 'telescope.ingest-csrf',
    lib: 'telescope',
    title: 'Ingest route passes CSRF',
    run: (app) => {
      const state = read(app);
      if (isResult(state)) return state;
      const { topology } = state;
      if (topology.topology !== 'control-plane') return skip('Not a control plane.');
      let csrf: unknown;
      try {
        csrf = app.config.get('shield.csrf');
      } catch {
        csrf = undefined;
      }
      const url = `${topology.ingest.path}/ingest`;
      return csrfExempts(csrf, url)
        ? { status: 'ok', message: `POST ${url} is not checked for a CSRF token.` }
        : {
            status: 'error',
            message: `Shield CSRF refuses POST ${url}: every app's entries are rejected.`,
            fix: 'In config/shield.ts: csrf.exceptRoutes: (ctx) => telescopeCsrfExceptions(ctx.request.url()), from @adonis-agora/telescope.',
            docs: DOCS,
          };
    },
  },
  {
    id: 'telescope.server-reachable',
    lib: 'telescope',
    title: 'Server accepts this app',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const state = read(app);
      if (isResult(state)) return state;
      const { topology } = state;
      if (topology.topology !== 'tenant') return skip('Not a tenant.');
      const server = httpServer(topology);
      if (server === null) {
        return skip(
          `Entries go over ${topology.transport.describe()}: see "Transport reaches the broker".`,
        );
      }
      return whoami({ ...topology.tenant, url: server });
    },
  },
  {
    id: 'telescope.transport',
    lib: 'telescope',
    title: 'Transport reaches the broker',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const state = read(app);
      if (isResult(state)) return state;
      const { topology } = state;
      if (topology.topology === 'standalone') return skip('Standalone: nothing to send.');
      const transport = topology.transport;
      if (transport === null || transport.driver === 'http') {
        return skip('HTTP: no broker between the apps and the control plane.');
      }
      const side = topology.topology === 'tenant' ? 'this app sends' : 'this control plane reads';
      try {
        const message = await transport.ping({ app: app as never });
        return { status: 'ok', message: `${message} (${side} ${transport.describe()})` };
      } catch (error) {
        return {
          status: 'error',
          message: `${transport.describe()} cannot be reached: ${error instanceof Error ? error.message : String(error)}`,
          fix:
            topology.topology === 'tenant'
              ? 'Check the transport in config/telescope.ts and the broker connection it names; entries wait in the local buffer meanwhile.'
              : 'Check the transport in config/telescope.ts and the broker connection it names: no broker entries are stored meanwhile.',
          docs: TRANSPORT_DOCS,
        };
      }
    },
  },
];
