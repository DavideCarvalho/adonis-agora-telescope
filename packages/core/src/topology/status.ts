import type { AgoraDoctorResult } from '../doctor/agora_doctor.js';
import type { TelescopeStore } from '../store.js';
import { type ResolvedTopology, serverPrefix, type TelescopeTenantOptions } from './config.js';
import { readToken } from './verify.js';
import { APP_HEADER } from './wire.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/telescope/concepts/central-server';

/** What `telescope:server:status` reports. */
export type TelescopeTopologyStatus =
  | { topology: 'standalone' }
  | {
      topology: 'tenant';
      server: string;
      partition: string;
      /** How the server sees this app's token. */
      accepted: boolean;
      /**
       * How the server sees this app's token. `relay`: the apps it may send entries for besides
       * its own (`'*'` = any), when the token may relay.
       */
      as?: { partition: string; environment?: string; relay?: '*' | string[] };
      /** `tenant.relay` is on: this app sends entries on behalf of other apps. */
      relaying?: boolean;
      message: string;
    }
  | {
      topology: 'control-plane';
      ingest: string;
      running: boolean;
      /** The apps the server has entries for, most entries first. */
      apps: Array<{ app: string; entries: number }>;
    };

/** The apps a store has entries for (`app:<id>` tags), with their entry counts. */
export async function appsInStore(
  store: TelescopeStore,
): Promise<Array<{ app: string; entries: number }>> {
  if (typeof store.countTags === 'function') {
    return (await store.countTags({ limit: 200, prefix: 'app:' })).map((row) => ({
      app: row.key.slice('app:'.length),
      entries: row.count,
    }));
  }
  const counts = new Map<string, number>();
  for (const entry of await store.list({ size: 5000, omitContent: true })) {
    for (const tag of entry.tags) {
      if (tag.startsWith('app:')) counts.set(tag.slice(4), (counts.get(tag.slice(4)) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([app, entries]) => ({ app, entries }))
    .sort((a, b) => b.entries - a.entries);
}

/** Build the status report (the command prints it). */
export async function telescopeTopologyStatus(
  config: ResolvedTopology,
  store: TelescopeStore | null,
  doFetch: typeof fetch = globalThis.fetch,
  app?: unknown,
): Promise<TelescopeTopologyStatus> {
  if (config.topology === 'tenant') {
    const tenant = config.tenant;
    const url = httpUrl(config);
    if (url === null) {
      // A broker carries the entries: report whether it answers.
      let accepted = true;
      let message: string;
      try {
        message = await config.transport.ping({ app: app as never });
      } catch (error) {
        accepted = false;
        message = `The broker (${config.transport.describe()}) cannot be reached: ${error instanceof Error ? error.message : String(error)}`;
      }
      return {
        topology: 'tenant',
        server: config.transport.describe(),
        partition: tenant.partition,
        accepted,
        ...(tenant.relay === true ? { relaying: true } : {}),
        message,
      };
    }
    const result = await whoami({ ...tenant, url }, doFetch);
    return {
      topology: 'tenant',
      server: serverPrefix(url),
      partition: tenant.partition,
      accepted: result.status !== 'error',
      ...(tenant.relay === true ? { relaying: true } : {}),
      ...(result.partition !== undefined
        ? {
            as: {
              partition: result.partition,
              ...(result.environment !== undefined ? { environment: result.environment } : {}),
              ...(result.relay !== undefined ? { relay: result.relay } : {}),
            },
          }
        : {}),
      message: result.message,
    };
  }
  if (config.topology === 'control-plane') {
    return {
      topology: 'control-plane',
      ingest: `POST ${config.ingest.path}/ingest${config.transport !== null ? ` + ${config.transport.describe()}` : ''}`,
      running: store !== null,
      apps: store !== null ? await appsInStore(store) : [],
    };
  }
  return { topology: 'standalone' };
}

/** The control plane's URL when a tenant sends over HTTP, else `null` (a broker). */
export function httpUrl(config: Extract<ResolvedTopology, { topology: 'tenant' }>): string | null {
  if (config.transport.driver !== 'http') return null;
  const options = (config.transport as { options?: { url?: unknown } }).options;
  return typeof options?.url === 'string' ? options.url : (config.tenant.url ?? null);
}

/** How a relay scope reads in a message. */
function describeRelay(relay: '*' | string[]): string {
  return relay === '*' ? 'any app' : relay.map((app) => JSON.stringify(app)).join(', ');
}

/** Ask the control plane who it takes this app for (and, with `relay`, whether it may relay). */
export async function whoami(
  tenant: Pick<TelescopeTenantOptions, 'partition' | 'token' | 'relay'> & { url: string },
  doFetch: typeof fetch = globalThis.fetch,
): Promise<
  AgoraDoctorResult & { partition?: string; environment?: string; relay?: '*' | string[] }
> {
  const prefix = serverPrefix(tenant.url);
  try {
    const token = await readToken(tenant.token);
    const response = await doFetch(`${prefix}/whoami`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        [APP_HEADER]: tenant.partition,
      },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      partition?: string;
      environment?: string;
      relay?: unknown;
    };
    if (response.status === 200 && typeof body.partition === 'string') {
      const env = body.environment !== undefined ? ` (${body.environment})` : '';
      const relay =
        body.relay === '*' ||
        (Array.isArray(body.relay) && body.relay.every((app) => typeof app === 'string'))
          ? (body.relay as '*' | string[])
          : undefined;
      const same = body.partition === tenant.partition;
      let message = same
        ? `The server accepts this app as ${JSON.stringify(body.partition)}${env}.`
        : `The server takes this app's token for ${JSON.stringify(body.partition)}${env}, not ${JSON.stringify(tenant.partition)}: entries are tagged with the token's app.`;
      if (relay !== undefined) message += ` It may relay entries for ${describeRelay(relay)}.`;
      const relayRefused = tenant.relay === true && relay === undefined;
      if (relayRefused) {
        message +=
          ' tenant.relay is on, but the token may not relay: entries tagged for other apps are stored as this app.';
      }
      return {
        status: same && !relayRefused ? 'ok' : 'warn',
        message,
        ...(relayRefused
          ? { fix: 'Give the token the telescope:ingest:relay capability.', docs: DOCS }
          : {}),
        partition: body.partition,
        ...(body.environment !== undefined ? { environment: body.environment } : {}),
        ...(relay !== undefined ? { relay } : {}),
      };
    }
    return {
      status: 'error',
      message: `The server refused this app's token (${response.status}).`,
      fix:
        response.status === 403
          ? 'Give the token the telescope:ingest capability.'
          : 'Check tenant.token here and verifyTenant on the server.',
      docs: DOCS,
    };
  } catch (error) {
    return {
      status: 'error',
      message: `The server at ${prefix} cannot be reached: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check tenant.url.',
      docs: DOCS,
    };
  }
}
