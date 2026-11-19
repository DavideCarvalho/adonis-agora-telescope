/**
 * What the AdonisJS first-party packages use, read from their configs: `drive` disks, `mail`
 * transports, `cache` stores and their layers, `lock`, `limiter` and `session` stores, the `queue`
 * adapter and the `transmit` transport.
 *
 * Their `defineConfig()` and driver helpers mostly return ConfigProviders that keep the options in
 * a closure (and `@adonisjs/cache` keeps a store's layers in private fields). Those are read with
 * the {@link Introspector}, which never resolves anything. Where it cannot read them, a disk or
 * mailer named after a known technology (`s3`, `resend`) still counts; nothing else is guessed.
 */
import type { StackUse } from './stack.js';
import type { Introspector } from './stack_introspect.js';

export interface FirstPartyContext {
  introspector: Introspector | null;
  /** The `config/redis.ts` connection pointing at the server `options` describe, if any. */
  redisConnectionAt(options: Record<string, unknown>): string | undefined;
}

type Mapper = (value: unknown, ctx: FirstPartyContext) => StackUse[];

interface Unwrapped {
  /** The driver: the helper that built the provider (`redis` for `stores.redis(config)`). */
  driver: string | undefined;
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isProvider(value: unknown): value is { type: 'provider'; resolver: unknown } {
  return isRecord(value) && value.type === 'provider' && typeof value.resolver === 'function';
}

/** A provider or driver factory's options and driver name; a plain object as it is. */
function unwrap(value: unknown, ctx: FirstPartyContext): Unwrapped | undefined {
  const fn = isProvider(value) ? value.resolver : typeof value === 'function' ? value : undefined;
  if (fn === undefined) {
    if (!isRecord(value)) return undefined;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null
      ? { driver: undefined, config: value }
      : undefined;
  }
  const view = ctx.introspector?.closure(fn);
  if (view === undefined) return undefined;
  return { driver: view.names[0], config: isRecord(view.vars.config) ? view.vars.config : {} };
}

/** The host of a URL, `''` when it is not one. Never the userinfo or the path. */
function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The stores a `default` (or `store`) key selects: that one; none when it names no store (the
 * package fails on it anyway); all when there is no such key.
 */
function selected(stores: unknown, pick: unknown): Array<[string, unknown]> {
  if (!isRecord(stores)) return [];
  if (typeof pick === 'string') return Object.hasOwn(stores, pick) ? [[pick, stores[pick]]] : [];
  return Object.entries(stores);
}

/**
 * A store driver (`redis`, `database`, `dynamodb`…) as a use. In-process drivers (`memory`,
 * `cookie`, `file`, `sync`) use nothing.
 */
function storeUse(
  driver: string | undefined,
  config: Record<string, unknown>,
  purpose: string | undefined,
): StackUse | undefined {
  const withPurpose = purpose !== undefined ? { purpose } : {};
  switch (driver) {
    case 'redis':
    case 'redisBus': {
      const connection = str(config.connectionName) ?? str(config.connection);
      return { tech: 'redis', ...(connection !== undefined ? { connection } : {}), ...withPurpose };
    }
    case 'database': {
      const connection = str(config.connectionName) ?? str(config.connection);
      return { tech: 'lucid', ...(connection !== undefined ? { connection } : {}), ...withPurpose };
    }
    case 'dynamodb': {
      const table = isRecord(config.table) ? str(config.table.name) : str(config.tableName);
      const client = isRecord(config.clientConfig) ? config.clientConfig : config;
      return {
        tech: 'dynamodb',
        label: table ?? 'dynamodb',
        host: str(client.endpoint) ? hostOf(client.endpoint) : String(client.region ?? ''),
        ...withPurpose,
      };
    }
    default:
      return undefined;
  }
}

/** Store names that say their driver when the store itself cannot be read. */
function storeUseByName(name: string): StackUse | undefined {
  return name === 'redis' ? storeUse('redis', {}, undefined) : undefined;
}

function storesOf(stores: Array<[string, unknown]>, ctx: FirstPartyContext): StackUse[] {
  const uses: StackUse[] = [];
  for (const [name, store] of stores) {
    const u = unwrap(store, ctx);
    const use = u !== undefined ? storeUse(u.driver, u.config, undefined) : storeUseByName(name);
    if (use !== undefined) uses.push(use);
  }
  return uses;
}

/** Disk and mailer names that are technologies (`s3`, `resend`): the last resort. */
const NAMED_TECH = new Set([
  's3',
  'gcs',
  'r2',
  'minio',
  'spaces',
  'smtp',
  'ses',
  'resend',
  'mailgun',
  'sparkpost',
  'postmark',
  'brevo',
  'sendgrid',
]);

/** An S3-compatible endpoint's vendor. */
function s3Tech(endpoint: string): string {
  if (endpoint.endsWith('r2.cloudflarestorage.com')) return 'r2';
  if (endpoint.endsWith('digitaloceanspaces.com')) return 'spaces';
  if (endpoint.includes('minio')) return 'minio';
  return 's3';
}

const drive: Mapper = (value, ctx) => {
  const top = unwrap(value, ctx);
  if (top === undefined) return [];
  const services = isRecord(top.config.services) ? top.config.services : {};
  const uses: StackUse[] = [];
  for (const [disk, service] of Object.entries(services)) {
    const purpose = `disk ${disk}`;
    const s = unwrap(service, ctx);
    if (s === undefined || s.driver === undefined) {
      if (NAMED_TECH.has(disk)) uses.push({ tech: disk, label: disk, purpose });
      continue;
    }
    const bucket = str(s.config.bucket);
    if (s.driver === 's3') {
      const endpoint = hostOf(s.config.endpoint);
      uses.push({
        tech: endpoint !== '' ? s3Tech(endpoint) : 's3',
        label: bucket ?? disk,
        host: endpoint !== '' ? endpoint : String(s.config.region ?? ''),
        purpose,
      });
    } else if (s.driver === 'gcs') {
      uses.push({ tech: 'gcs', label: bucket ?? disk, purpose });
    } else if (s.driver === 'fs' && disk === top.config.default) {
      // A local folder is worth showing only when it is where the app's files go.
      uses.push({ tech: 'fs', label: disk, purpose });
    }
  }
  return uses;
};

/** What an SMTP server is, by its host. */
function smtpTech(host: string): string {
  const vendors: Array<[string, string]> = [
    ['resend', 'resend'],
    ['mailgun', 'mailgun'],
    ['sendgrid', 'sendgrid'],
    ['postmarkapp', 'postmark'],
    ['sparkpost', 'sparkpost'],
    ['brevo', 'brevo'],
    ['sendinblue', 'brevo'],
    ['amazonaws.com', 'ses'],
  ];
  for (const [needle, tech] of vendors) if (host.includes(needle)) return tech;
  return 'smtp';
}

const MAIL_TRANSPORTS = new Set([
  'smtp',
  'ses',
  'resend',
  'mailgun',
  'sparkpost',
  'postmark',
  'brevo',
]);

const mail: Mapper = (value, ctx) => {
  const top = unwrap(value, ctx);
  if (top === undefined) return [];
  const mailers = isRecord(top.config.mailers) ? top.config.mailers : {};
  const uses: StackUse[] = [];
  for (const [mailer, transport] of Object.entries(mailers)) {
    const purpose = `mailer ${mailer}`;
    const t = unwrap(transport, ctx);
    if (t === undefined || t.driver === undefined || !MAIL_TRANSPORTS.has(t.driver)) {
      if (NAMED_TECH.has(mailer)) uses.push({ tech: mailer, label: mailer, purpose });
      continue;
    }
    const host =
      t.driver === 'smtp'
        ? String(t.config.host ?? '')
        : hostOf(t.config.baseUrl) || String(t.config.region ?? '');
    uses.push({
      tech: t.driver === 'smtp' ? smtpTech(host) : t.driver,
      label: mailer,
      host,
      purpose,
    });
  }
  return uses;
};

const cache: Mapper = (value, ctx) => {
  if (!isRecord(value) || !isRecord(value.stores)) return [];
  const uses: StackUse[] = [];
  for (const [name, store] of Object.entries(value.stores)) {
    const fields = ctx.introspector?.privates(store);
    if (fields === undefined) continue;
    for (const [field, label] of [
      ['#l2', `store ${name}`],
      ['#bus', `store ${name} (bus)`],
    ] as const) {
      const layer = unwrap(fields[field], ctx);
      const use = layer !== undefined ? storeUse(layer.driver, layer.config, label) : undefined;
      if (use !== undefined) uses.push(use);
    }
  }
  return uses;
};

/**
 * `lock` and `queue` are plain objects holding providers, `limiter` and `session` providers. One
 * store is in use at a time: the selected one.
 */
function storesMapper(storesKey: 'stores' | 'adapters', pickKey: 'default' | 'store'): Mapper {
  return (value, ctx) => {
    const top = unwrap(value, ctx);
    if (top === undefined || top.config.enabled === false) return [];
    return storesOf(selected(top.config[storesKey], top.config[pickKey]), ctx);
  };
}

const transmit: Mapper = (value, ctx) => {
  if (!isRecord(value) || !isRecord(value.transport)) return [];
  const t = unwrap(value.transport.driver, ctx);
  if (t === undefined) return [];
  if (t.driver === 'redis') {
    const connection = ctx.redisConnectionAt(t.config);
    if (connection !== undefined) return [{ tech: 'redis', connection }];
    const host = str(t.config.url) ? hostOf(t.config.url) : String(t.config.host ?? '');
    // No address to tell it apart: not a server to draw.
    if (host === '') return [];
    return [{ tech: 'redis', label: 'transmit', host: `${host}:${String(t.config.port ?? '')}` }];
  }
  if (t.driver === 'mqtt') {
    const host = hostOf(t.config.url);
    return host !== '' ? [{ tech: 'mqtt', label: 'transmit', host }] : [];
  }
  return [];
};

/** The mappers, by the config namespace each package's config file is (`config/<name>.ts`). */
export const FIRST_PARTY: Record<string, Mapper> = {
  drive,
  mail,
  cache,
  lock: storesMapper('stores', 'default'),
  limiter: storesMapper('stores', 'default'),
  session: storesMapper('stores', 'store'),
  queue: storesMapper('adapters', 'default'),
  transmit,
};
