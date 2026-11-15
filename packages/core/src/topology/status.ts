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
      as?: { partition: string; environment?: string };
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
): Promise<TelescopeTopologyStatus> {
  if (config.topology === 'tenant') {
    const tenant = config.tenant;
    const result = await whoami(tenant, doFetch);
    return {
      topology: 'tenant',
      server: serverPrefix(tenant.url),
      partition: tenant.partition,
      accepted: result.status !== 'error',
      ...(result.partition !== undefined
        ? {
            as: {
              partition: result.partition,
              ...(result.environment !== undefined ? { environment: result.environment } : {}),
            },
          }
        : {}),
      message: result.message,
    };
  }
  if (config.topology === 'control-plane') {
    return {
      topology: 'control-plane',
      ingest: `POST ${config.ingest.path}/ingest`,
      running: store !== null,
      apps: store !== null ? await appsInStore(store) : [],
    };
  }
  return { topology: 'standalone' };
}

/** Ask the control plane who it takes this app for. */
export async function whoami(
  tenant: Pick<TelescopeTenantOptions, 'url' | 'partition' | 'token'>,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<AgoraDoctorResult & { partition?: string; environment?: string }> {
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
    };
    if (response.status === 200 && typeof body.partition === 'string') {
      const env = body.environment !== undefined ? ` (${body.environment})` : '';
      return {
        status: body.partition === tenant.partition ? 'ok' : 'warn',
        message:
          body.partition === tenant.partition
            ? `The server accepts this app as ${JSON.stringify(body.partition)}${env}.`
            : `The server takes this app's token for ${JSON.stringify(body.partition)}${env}, not ${JSON.stringify(tenant.partition)}: entries are tagged with the token's app.`,
        partition: body.partition,
        ...(body.environment !== undefined ? { environment: body.environment } : {}),
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
