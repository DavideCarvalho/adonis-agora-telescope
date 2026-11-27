import type { TelescopeTenantOptions, TelescopeTopologyConfig } from './config.js';
import type { LazyServerUrl } from './server_url.js';
import { TELESCOPE_RESOURCE } from './verify.js';

/**
 * Zero-config tenant: with `@adonis-agora/authkit-client` booted in this app (its `service`
 * configured), `defineConfig({ topology: 'tenant' })` is enough. The control plane's URL, the
 * service token and this app's partition come from `authkit.client`'s `tenantOf(resource)`.
 *
 * Read structurally: this package never imports authkit-client. A binding without `tenantOf` (an
 * older authkit-client) counts as absent.
 */

/** The `'authkit.client'` container binding of `@adonis-agora/authkit-client`. */
const AUTHKIT_BINDING = 'authkit.client';

/** What `tenantOf(resource)` returns, as far as telescope uses it. */
export interface AuthkitTenant {
  url: LazyServerUrl;
  token: (() => Promise<string>) & { reset?(): void };
  partition: string;
}

interface AuthkitTenantClient {
  tenantOf(resource: string): AuthkitTenant | Promise<AuthkitTenant>;
}

/** Where one tenant field came from. */
export type TenantFieldSource = 'authkit-client (auto)' | 'explicit';

/** Where `tenant.url`, `tenant.token` and `tenant.partition` came from. */
export interface TenantProvenance {
  url: TenantFieldSource;
  token: TenantFieldSource;
  partition: TenantFieldSource;
}

/** The tenant fields telescope can take from authkit-client. */
export type AutoTenantField = keyof TenantProvenance;

interface Filled {
  tenant: TelescopeTenantOptions;
  provenance: TenantProvenance;
}

/** The tenant authkit-client completed, per `config/telescope.ts` object. */
const filled = new WeakMap<object, Filled>();
/** A failed `tenantOf` (no `service`), per config object: its message goes into the boot error. */
const failures = new WeakMap<object, string>();
/** One lookup per config object. */
const pending = new WeakMap<object, Promise<void>>();

const PREFIX = '[@adonis-agora/telescope]';

const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/** The tenant fields `config` leaves out (`url` is not needed when `transport` is set). */
export function missingTenantFields(
  config: TelescopeTopologyConfig,
  tenant: Partial<TelescopeTenantOptions> = config.tenant ?? {},
): AutoTenantField[] {
  const missing: AutoTenantField[] = [];
  // A url that is set but not usable (`''`, `null`) is reported as such, not as missing.
  if (config.transport === undefined && tenant.url === undefined) missing.push('url');
  if (!present(tenant.token)) missing.push('token');
  if (!present(tenant.partition)) missing.push('partition');
  return missing;
}

/** The boot error when tenant fields are missing and authkit-client cannot supply them. */
export function missingTenantMessage(missing: AutoTenantField[], cause?: string): string {
  const fields = missing.map((field) => `tenant.${field}`).join(', ');
  return `${PREFIX} topology 'tenant' needs ${fields}. Configure @adonis-agora/authkit-client's \`service\` (config/authkit_client.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/telescope.ts.${cause ? ` (authkit-client: ${cause})` : ''}`;
}

/** A tenant without `url`, `token` or `partition`, and no authkit-client to supply them. */
export class MissingTenantError extends Error {
  constructor(
    readonly missing: AutoTenantField[],
    cause?: string,
  ) {
    super(missingTenantMessage(missing, cause));
    this.name = 'MissingTenantError';
  }
}

/** `authkit.client` when it is bound, resolves and has `tenantOf`; else `undefined`. */
export async function authkitTenantClient(
  container: unknown,
): Promise<AuthkitTenantClient | undefined> {
  const c = container as {
    hasBinding?(binding: string): boolean;
    make?(binding: string): Promise<unknown>;
  } | null;
  if (!c || typeof c.hasBinding !== 'function' || typeof c.make !== 'function') return undefined;
  try {
    if (!c.hasBinding(AUTHKIT_BINDING)) return undefined;
    const client = (await c.make(AUTHKIT_BINDING)) as { tenantOf?: unknown } | null | undefined;
    return client && typeof client.tenantOf === 'function'
      ? (client as AuthkitTenantClient)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Completes `config.tenant` from authkit-client when `topology` is `'tenant'`, a field is missing
 * and `tenant.auto` is not `false`. Field by field, anything explicit wins. The result is kept for
 * this config object, so every later `resolveTopology(config)` (the provider, the console, the
 * doctor) sees it. Never throws: what stays missing is reported by `resolveTopology`.
 */
export function fillTenantFromAuthkit(
  container: unknown,
  config: TelescopeTopologyConfig | undefined,
): Promise<void> {
  if (!config || typeof config !== 'object' || config.topology !== 'tenant') {
    return Promise.resolve();
  }
  let running = pending.get(config);
  if (running === undefined) {
    running = fill(container, config);
    pending.set(config, running);
  }
  return running;
}

async function fill(container: unknown, config: TelescopeTopologyConfig): Promise<void> {
  const explicit = (config.tenant ?? {}) as Partial<TelescopeTenantOptions>;
  const missing = missingTenantFields(config);
  if (missing.length === 0 || explicit.auto === false) return;
  const client = await authkitTenantClient(container);
  if (client === undefined) return;
  let auto: AuthkitTenant;
  try {
    // Awaited: a `tenantOf` that returns a promise works too, and its rejection is caught here.
    auto = await client.tenantOf(TELESCOPE_RESOURCE);
  } catch (error) {
    failures.set(config, error instanceof Error ? error.message : String(error));
    return;
  }
  const tenant: Partial<TelescopeTenantOptions> = { ...explicit };
  const provenance: TenantProvenance = {
    url: 'explicit',
    token: 'explicit',
    partition: 'explicit',
  };
  for (const field of missing) {
    const value = auto?.[field];
    if (!present(value)) continue;
    (tenant as Record<string, unknown>)[field] = value;
    provenance[field] = 'authkit-client (auto)';
  }
  filled.set(config, { tenant: tenant as TelescopeTenantOptions, provenance });
}

/** `config.tenant` completed by authkit-client, or `undefined` when nothing was filled. */
export function autoFilledTenant(config: object): TelescopeTenantOptions | undefined {
  return filled.get(config)?.tenant;
}

/** Why authkit-client could not supply the tenant (its `tenantOf` threw), if it did. */
export function autoTenantFailure(config: object): string | undefined {
  return failures.get(config);
}

/** Where each tenant field of `config` came from (all `explicit` when nothing was filled). */
export function tenantProvenance(config: object): TenantProvenance {
  return (
    filled.get(config)?.provenance ?? { url: 'explicit', token: 'explicit', partition: 'explicit' }
  );
}

/** `tenant url: …, token: …, partition: …` for the doctor. */
export function describeTenantProvenance(provenance: TenantProvenance): string {
  return `tenant url: ${provenance.url}, token: ${provenance.token}, partition: ${provenance.partition}`;
}
