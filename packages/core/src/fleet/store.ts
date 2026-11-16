import { runAsTelescopeWork } from '../self_scope.js';
import { dialectOf, type LucidDatabaseLike, runIdempotentDdl } from '../stores/lucid.js';
import {
  ensureSchema,
  qualifiedName,
  qualifiedSql,
  quoteIdentifier,
} from '../stores/sql_schema.js';
import type { CheckState } from './checks.js';
import type { InstanceRecord } from './derive.js';
import { DEFAULT_ROLE, normalizeRole, type ShippingStats } from './heartbeat.js';

/** Where the fleet keeps its instances. */
export interface FleetStore {
  /** Insert or replace one instance (keyed by app + instance id). */
  upsert(record: InstanceRecord): Promise<void>;
  /** Instances seen since `since` (epoch ms), of `apps` (`null`: every app). */
  list(filter?: { apps?: readonly string[] | null; since?: number }): Promise<InstanceRecord[]>;
  /** Delete instances last seen before `before` (epoch ms). Returns how many. */
  prune(before: number): Promise<number>;
}

const key = (app: string, instanceId: string) => `${app}\u0000${instanceId}`;

/** Instances in this process (a standalone app, tests, or a control plane on the memory store). */
export class MemoryFleetStore implements FleetStore {
  private readonly rows = new Map<string, InstanceRecord>();

  constructor(private readonly maxInstances = 5000) {}

  async upsert(record: InstanceRecord): Promise<void> {
    const id = key(record.app, record.instanceId);
    this.rows.delete(id);
    this.rows.set(id, structuredClone(record));
    while (this.rows.size > this.maxInstances) {
      // Evict the least recently seen (insertion order = last upsert).
      this.rows.delete(this.rows.keys().next().value as string);
    }
  }

  async list(
    filter: { apps?: readonly string[] | null; since?: number } = {},
  ): Promise<InstanceRecord[]> {
    const apps = filter.apps ?? null;
    const since = filter.since ?? 0;
    return [...this.rows.values()]
      .filter((r) => (apps === null || apps.includes(r.app)) && r.lastSeenAt >= since)
      .map((r) => structuredClone(r));
  }

  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.lastSeenAt < before) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/** The instances table's default name. */
export const INSTANCES_TABLE_NAME = 'telescope_instances';

/** `CREATE TABLE IF NOT EXISTS` for the instances table (and its index), in `dialect`. */
export function instancesTableStatements(
  tableName = INSTANCES_TABLE_NAME,
  dialect?: string,
  schema?: string,
): string[] {
  const q = (identifier: string) => quoteIdentifier(identifier, dialect);
  const table = qualifiedSql(tableName, schema, dialect);
  const mysql = dialect === 'mysql' || dialect === 'mysql2';
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      ${q('id')} VARCHAR(255) PRIMARY KEY NOT NULL,
      ${q('app')} VARCHAR(64) NOT NULL,
      ${q('instance_id')} VARCHAR(128) NOT NULL,
      ${q('host')} VARCHAR(255) NOT NULL,
      ${q('version')} VARCHAR(100) NULL,
      ${q('state')} VARCHAR(16) NOT NULL,
      ${q('booted_at')} BIGINT NOT NULL,
      ${q('first_seen_at')} BIGINT NOT NULL,
      ${q('last_seen_at')} BIGINT NOT NULL,
      ${q('data')} TEXT NOT NULL
    )`,
    `CREATE INDEX ${mysql ? '' : 'IF NOT EXISTS '}${q(`${tableName}_app_last_seen_idx`)} ON ${table} (${q('app')}, ${q('last_seen_at')})`,
  ];
}

/** Options of {@link LucidFleetStore}. */
export interface LucidFleetStoreOptions {
  /** Default `telescope_instances`. */
  tableName?: string;
  /** The schema the entries table is in (`storage.lucid({ schema })`). */
  schema?: string;
  /** Create the table on first use (`storage.lucid({ autoCreateTable })`). */
  autoCreateTable?: boolean;
}

interface Payload {
  environment: string | null;
  pid: number;
  intervalMs: number;
  checks: CheckState[];
  shipping: ShippingStats | null;
  url?: string | null;
  role?: string;
}

const toInt = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));

/**
 * Instances in a SQL table next to the entries table (same connection, same `schema`). Several
 * replicas of a standalone app, or a control plane behind a load balancer, share it.
 */
export class LucidFleetStore implements FleetStore {
  private readonly table: string;
  private readonly tableName: string;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: LucidDatabaseLike,
    private readonly options: LucidFleetStoreOptions = {},
  ) {
    this.tableName = options.tableName ?? INSTANCES_TABLE_NAME;
    this.table = qualifiedName(this.tableName, options.schema);
  }

  private init(): Promise<void> {
    if (this.ready === null) {
      const attempt = runAsTelescopeWork(async () => {
        if (!this.options.autoCreateTable) return;
        const dialect = dialectOf(this.db);
        if (this.options.schema !== undefined) {
          await ensureSchema(this.db, this.options.schema, dialect, (stmt) =>
            runIdempotentDdl(this.db, stmt),
          );
        }
        for (const stmt of instancesTableStatements(this.tableName, dialect, this.options.schema)) {
          try {
            await runIdempotentDdl(this.db, stmt);
          } catch (error) {
            const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
            // MySQL has no CREATE INDEX IF NOT EXISTS: an existing index is fine.
            if (code !== 'ER_DUP_KEYNAME' && errno !== 1061) throw error;
          }
        }
      });
      this.ready = attempt;
      attempt.catch(() => {
        if (this.ready === attempt) this.ready = null;
      });
    }
    return this.ready;
  }

  async upsert(record: InstanceRecord): Promise<void> {
    await this.init();
    const id = key(record.app, record.instanceId).replace('\u0000', ':');
    const payload: Payload = {
      environment: record.environment,
      pid: record.pid,
      intervalMs: record.intervalMs,
      checks: record.checks,
      shipping: record.shipping,
      url: record.url ?? null,
      role: record.role ?? DEFAULT_ROLE,
    };
    const row = {
      id,
      app: record.app,
      instance_id: record.instanceId,
      host: record.host,
      version: record.version,
      state: record.state,
      booted_at: record.bootedAt,
      first_seen_at: record.firstSeenAt,
      last_seen_at: record.lastSeenAt,
      data: JSON.stringify(payload),
    };
    await runAsTelescopeWork(async () => {
      // Portable upsert: delete + insert (a heartbeat replaces the whole row).
      await this.db.from(this.table).where('id', id).delete();
      try {
        await this.db.table(this.table).insert(row);
      } catch {
        // Another writer inserted it between the two statements: replace it again.
        await this.db.from(this.table).where('id', id).delete();
        await this.db.table(this.table).insert(row);
      }
    });
  }

  async list(
    filter: { apps?: readonly string[] | null; since?: number } = {},
  ): Promise<InstanceRecord[]> {
    await this.init();
    const apps = filter.apps ?? null;
    if (apps !== null && apps.length === 0) return [];
    const rows = await runAsTelescopeWork(() => {
      let query = this.db.from(this.table).where('last_seen_at', '>=', filter.since ?? 0);
      if (apps !== null) query = query.whereIn('app', apps);
      return query.orderBy('last_seen_at', 'desc').limit(5000).select('*');
    });
    return rows.map((row) => {
      let payload: Partial<Payload> = {};
      try {
        payload = JSON.parse(String(row.data ?? '{}')) as Partial<Payload>;
      } catch {
        // A damaged row: shown without its checks.
      }
      return {
        app: String(row.app),
        instanceId: String(row.instance_id),
        environment: payload.environment ?? null,
        host: String(row.host),
        pid: payload.pid ?? 0,
        version: row.version === null || row.version === undefined ? null : String(row.version),
        bootedAt: toInt(row.booted_at),
        firstSeenAt: toInt(row.first_seen_at),
        lastSeenAt: toInt(row.last_seen_at),
        state: String(row.state) as InstanceRecord['state'],
        intervalMs: payload.intervalMs ?? 15_000,
        checks: Array.isArray(payload.checks) ? payload.checks : [],
        shipping: payload.shipping ?? null,
        url: payload.url ?? null,
        // Rows written before roles existed were web processes.
        role: normalizeRole(payload.role),
      };
    });
  }

  async prune(before: number): Promise<number> {
    await this.init();
    return runAsTelescopeWork(() =>
      this.db.from(this.table).where('last_seen_at', '<', before).delete(),
    );
  }
}
