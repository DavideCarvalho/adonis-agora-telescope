/**
 * What an app runs on: its databases, Redis servers, buckets, mail providers… and what in the app
 * uses each one. Read once at boot from the app's config and sent with the heartbeat, so the
 * Architecture page can draw the infrastructure next to the apps.
 *
 * Three sources:
 *
 * - the AdonisJS `database` and `redis` configs (plain objects): each connection, its technology
 *   and the server it points at;
 * - the AdonisJS first-party packages (`drive`, `mail`, `cache`, `lock`, `limiter`, `session`,
 *   `queue`, `transmit`), whose options sit in ConfigProvider closures (see `stack_adonis.ts`);
 * - **descriptors**: a store, disk or transport factory can carry what it uses under the global
 *   symbol {@link STACK_DESCRIPTOR} (see {@link describeStackUse}), so a lib says
 *   "postgres via the `hub` connection, for run history" without the config showing it. Plain
 *   `connection` / `connectionName` fields elsewhere in a config count too.
 *
 * No credential leaves the app: a server is identified by a short hash of its host, port and
 * database, and labelled by the database (or connection) name only.
 */
import { createHash } from 'node:crypto';
import { FIRST_PARTY } from './stack_adonis.js';
import { createIntrospector, type Introspector } from './stack_introspect.js';

/** The symbol a factory carries its {@link StackUse} under. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** What a factory (store, disk, transport) uses. */
export interface StackUse {
  /**
   * `postgres`, `mysql`, `sqlite`, `redis`, `s3`, `gcs`, `fs`, `resend`, `smtp`, `ses`, … Two
   * mean a connection of the app: `lucid` (a Lucid connection, whatever its database; the default
   * one without `connection`) and `redis` without `connection`, `label` or `host` (the default
   * Redis connection).
   */
  tech: string;
  /** The Lucid or Redis connection it goes through, when it uses one. */
  connection?: string;
  /** What it is for, in a few words (`run history`, `queues`, `avatars`). */
  purpose?: string;
  /** For a bucket or a mail provider: a label (`hub-avatars`, `resend`). */
  label?: string;
  /** For a bucket or an API: its host, to tell two of them apart (hashed, never sent). */
  host?: string;
}

/**
 * Attach `use` to `target` (a factory function or object) so telescope's Architecture page shows
 * it. Returns `target`. Several uses: call it once with an array.
 */
export function describeStackUse<T extends object>(target: T, use: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(use) ? use : [use],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}

/** One backend the app uses, and what in the app uses it. */
export interface StackEntry {
  /** Stable across apps for the same server: `<tech>:<hash>`. */
  id: string;
  tech: string;
  /** The database, bucket or connection name. */
  label: string;
  /** What uses it: `app` (the app's own models), a config name (`durable`, `cache`), a purpose. */
  uses: string[];
}

const MAX_ENTRIES = 30;
const MAX_USES = 20;
const MAX_NODES = 5000;

interface ConfigLike {
  get(key: string, fallback?: unknown): unknown;
  all?(): Record<string, unknown>;
}

const DB_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  'pg-native': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
  oracledb: 'oracle',
};

function hash(parts: unknown[]): string {
  return createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 10);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** host, port and database of a Lucid connection (its `connection` object or connection string). */
function dbTarget(conn: Record<string, unknown>): { host: string; port: string; database: string } {
  const c = conn.connection;
  if (typeof c === 'string') {
    try {
      const url = new URL(c);
      return { host: url.hostname, port: url.port, database: url.pathname.replace(/^\//, '') };
    } catch {
      return { host: '', port: '', database: c.split('/').pop() ?? '' };
    }
  }
  if (isRecord(c)) {
    const cs = str(c.connectionString);
    if (cs) {
      try {
        const url = new URL(cs);
        return { host: url.hostname, port: url.port, database: url.pathname.replace(/^\//, '') };
      } catch {
        // fall through
      }
    }
    return {
      host: String(c.host ?? ''),
      port: String(c.port ?? ''),
      database: String(c.database ?? c.filename ?? ''),
    };
  }
  return { host: '', port: '', database: '' };
}

function redisTarget(conn: Record<string, unknown>): { host: string; port: string; db: string } {
  const url = str(conn.url);
  if (url) {
    try {
      const u = new URL(url);
      return { host: u.hostname, port: u.port, db: u.pathname.replace(/^\//, '') };
    } catch {
      // fall through
    }
  }
  return {
    host: String(conn.host ?? ''),
    port: String(conn.port ?? ''),
    db: String(conn.db ?? ''),
  };
}

class StackBuilder {
  private readonly entries = new Map<string, StackEntry>();

  add(id: string, tech: string, label: string): StackEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, tech, label, uses: [] };
      this.entries.set(id, entry);
    }
    return entry;
  }

  use(entry: StackEntry | undefined, by: string): void {
    if (!entry || by === '' || entry.uses.includes(by) || entry.uses.length >= MAX_USES) return;
    entry.uses.push(by);
  }

  list(): StackEntry[] {
    return [...this.entries.values()]
      .map((e) => ({ ...e, uses: [...e.uses].sort() }))
      .sort((a, b) => a.tech.localeCompare(b.tech) || a.label.localeCompare(b.label))
      .slice(0, MAX_ENTRIES);
  }
}

/** Every descriptor and plain connection reference under `value`, with the config path it sits at. */
function walk(
  value: unknown,
  visit: (found: { uses?: StackUse[]; connection?: string }) => void,
): void {
  const seen = new Set<unknown>();
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const { v, depth } = stack.pop() as { v: unknown; depth: number };
    if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) continue;
    seen.add(v);
    visited += 1;
    const described = (v as Record<symbol, unknown>)[STACK_DESCRIPTOR];
    if (Array.isArray(described)) {
      visit({
        uses: described.filter((u): u is StackUse => isRecord(u) && typeof u.tech === 'string'),
      });
    }
    if (typeof v === 'function' || depth >= 8) continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
      continue;
    }
    // Class instances (a client, a store already built) are not config: their own fields are not
    // walked, only a descriptor on them.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) continue;
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      if ((key === 'connection' || key === 'connectionName') && typeof child === 'string') {
        visit({ connection: child });
      } else {
        stack.push({ v: child, depth: depth + 1 });
      }
    }
  }
}

/** Config namespaces that are not things an app "uses" infrastructure for. */
const SKIP_NAMESPACES = new Set(['database', 'redis', 'app', 'logger', 'hash', 'encryption']);

/**
 * A config that picks one of its `stores` with `store` (telescope's own): only that one is in use.
 */
function selectedStore(value: unknown): unknown {
  if (!isRecord(value) || typeof value.store !== 'string' || !isRecord(value.stores)) return value;
  if (!(value.store in value.stores)) return value;
  return { ...value, stores: { [value.store]: value.stores[value.store] } };
}

export interface DescribeStackOptions {
  /**
   * Read the options the first-party packages keep in closures (through an in-process
   * `node:inspector` session that runs none of their code). Default `true`.
   */
  introspect?: boolean;
  /** How long reading them may take, in all. Default 100 ms. */
  budgetMs?: number;
}

/**
 * The app's stack from its config. Never throws: a config it cannot read contributes nothing.
 */
export function describeStack(
  config: ConfigLike,
  options: DescribeStackOptions = {},
): StackEntry[] {
  const builder = new StackBuilder();
  const dbByName = new Map<string, StackEntry>();
  const redisByName = new Map<string, StackEntry>();
  const redisTargets = new Map<string, string>();
  let primaryDb: string | undefined;
  let primaryRedis: string | undefined;

  try {
    const database = config.get('database') as Record<string, unknown> | undefined;
    const connections = isRecord(database?.connections) ? database.connections : {};
    for (const [name, raw] of Object.entries(connections)) {
      if (!isRecord(raw)) continue;
      const tech = DB_TECH[String(raw.client ?? '')] ?? String(raw.client ?? 'sql');
      const target = dbTarget(raw);
      const entry = builder.add(
        `${tech}:${hash([target.host, target.port, target.database])}`,
        tech,
        target.database || name,
      );
      dbByName.set(name, entry);
    }
    primaryDb = str(database?.connection);
    if (primaryDb) builder.use(dbByName.get(primaryDb), 'app');
  } catch {
    // no database config
  }

  try {
    const redis = config.get('redis') as Record<string, unknown> | undefined;
    const connections = isRecord(redis?.connections) ? redis.connections : {};
    for (const [name, raw] of Object.entries(connections)) {
      if (!isRecord(raw)) continue;
      const target = redisTarget(raw);
      const key = hash([target.host, target.port, target.db]);
      redisByName.set(name, builder.add(`redis:${key}`, 'redis', name));
      if (!redisTargets.has(key)) redisTargets.set(key, name);
    }
    primaryRedis = str(redis?.connection);
  } catch {
    // no redis config
  }

  /** The entry a use goes through: one of the app's connections, when it names (or implies) one. */
  const connectionOf = (use: StackUse): StackEntry | undefined => {
    if (use.tech === 'lucid') {
      const name = use.connection ?? primaryDb;
      return name !== undefined ? dbByName.get(name) : undefined;
    }
    if (use.connection !== undefined) {
      return use.tech === 'redis'
        ? (redisByName.get(use.connection) ?? dbByName.get(use.connection))
        : (dbByName.get(use.connection) ?? redisByName.get(use.connection));
    }
    if (use.tech === 'redis' && use.label === undefined && use.host === undefined) {
      return primaryRedis !== undefined ? redisByName.get(primaryRedis) : undefined;
    }
    return undefined;
  };

  const record = (use: StackUse, namespace: string): void => {
    if (!isRecord(use) || typeof use.tech !== 'string' || use.tech === '') return;
    const by = use.purpose ? `${namespace}: ${use.purpose}` : namespace;
    const entry = connectionOf(use);
    if (entry) {
      builder.use(entry, by);
      return;
    }
    // A connection the app does not have (or an unknown default) is not a server to draw.
    if (
      use.tech === 'lucid' ||
      (use.tech === 'redis' && use.label === undefined && use.host === undefined)
    ) {
      return;
    }
    const label = use.label ?? use.connection ?? use.tech;
    builder.use(builder.add(`${use.tech}:${hash([use.host, label])}`, use.tech, label), by);
  };

  let namespaces: Record<string, unknown> = {};
  try {
    namespaces = config.all?.() ?? {};
  } catch {
    namespaces = {};
  }

  let introspector: Introspector | null | undefined;
  const firstParty = {
    get introspector(): Introspector | null {
      // Opened only when a first-party config is there to read, and once.
      if (introspector === undefined) {
        introspector = options.introspect === false ? null : createIntrospector(options.budgetMs);
      }
      return introspector;
    },
    redisConnectionAt: (raw: Record<string, unknown>): string | undefined => {
      const target = redisTarget(raw);
      return redisTargets.get(hash([target.host, target.port, target.db]));
    },
  };

  try {
    for (const [namespace, value] of Object.entries(namespaces)) {
      if (SKIP_NAMESPACES.has(namespace)) continue;
      try {
        const mapper = Object.hasOwn(FIRST_PARTY, namespace) ? FIRST_PARTY[namespace] : undefined;
        if (mapper !== undefined) {
          for (const use of mapper(value, firstParty)) record(use, namespace);
        }
        walk(selectedStore(value), (found) => {
          if (found.connection !== undefined) {
            const name = found.connection;
            // A name both configs know is ambiguous: `connectionName` is Redis in the AdonisJS libs,
            // but nothing here tells which key it came from, so a Lucid connection wins.
            builder.use(dbByName.get(name) ?? redisByName.get(name), namespace);
            return;
          }
          for (const use of found.uses ?? []) record(use, namespace);
        });
      } catch {
        // a namespace that cannot be read contributes nothing
      }
    }
  } finally {
    introspector?.dispose();
  }

  return builder.list();
}

const TECH_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}:[a-f0-9]{1,16}$/;

/** Validate a stack a sender put in its heartbeat. `undefined` when absent or not a list. */
export function normalizeStack(raw: unknown): StackEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StackEntry[] = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (!isRecord(item)) continue;
    const tech = typeof item.tech === 'string' ? item.tech.toLowerCase() : '';
    const id = typeof item.id === 'string' ? item.id.toLowerCase() : '';
    if (!TECH_RE.test(tech) || !ID_RE.test(id)) continue;
    const label = typeof item.label === 'string' ? item.label.slice(0, 80) : tech;
    const uses = Array.isArray(item.uses)
      ? item.uses
          .filter((u): u is string => typeof u === 'string' && u !== '')
          .slice(0, MAX_USES)
          .map((u) => u.slice(0, 80))
      : [];
    out.push({ id, tech, label, uses });
  }
  return out;
}
