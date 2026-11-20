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
import { DEFAULT_ROLE, normalizeRole, normalizeWatchers, type ShippingStats } from './heartbeat.js';
import { normalizeStack, type StackEntry } from './stack.js';

/** Where the fleet keeps its instances. */
export interface FleetStore {
  /**
   * Insert or replace one instance (keyed by app + instance id). A replaced instance keeps the
   * `firstSeenAt` it was stored with (its creation time), whatever the record says.
   */
  upsert(record: InstanceRecord): Promise<void>;
  /** Instances seen since `since` (epoch ms), of `apps` (`null`: every app). */
  list(filter?: { apps?: readonly string[] | null; since?: number }): Promise<InstanceRecord[]>;
  /** Delete instances last seen before `before` (epoch ms). Returns how many. */
  prune(before: number): Promise<number>;
}

const key = (app: string, instanceId: string) => `${app}\u0000${instanceId}`;

/** The earlier of a stored first-seen time and `candidate`; `candidate` when the stored one is damaged. */
const earliest = (stored: number, candidate: number) =>
  Number.isFinite(stored) && stored > 0 ? Math.min(stored, candidate) : candidate;

/** Instances in this process (a standalone app, tests, or a control plane on the memory store). */
export class MemoryFleetStore implements FleetStore {
  private readonly rows = new Map<string, InstanceRecord>();

  constructor(private readonly maxInstances = 5000) {}

  async upsert(record: InstanceRecord): Promise<void> {
    const id = key(record.app, record.instanceId);
    const previous = this.rows.get(id);
    this.rows.delete(id);
    const row = structuredClone(record);
    if (previous !== undefined) row.firstSeenAt = earliest(previous.firstSeenAt, row.firstSeenAt);
    this.rows.set(id, row);
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
  watchers?: string[];
  stack?: StackEntry[];
}

/** `{ watchers }` when the row stored a list (newer senders), else `null` (unknown). */
const watchersOf = (value: unknown): { watchers: string[] } | null => {
  const watchers = normalizeWatchers(value);
  return watchers === undefined ? null : { watchers };
};

const toInt = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));

/**
 * Instances in a SQL table next to the entries table (same connection, same `schema`). Several
 * replicas of a standalone app, or a control plane behind a load balancer, share it.
 */
export class LucidFleetStore implements FleetStore {
  private readonly table: string;
  private readonly tableName: string;
  private ready: Promise<void> | null = null;
  /**
   * `first_seen_at` per row id, read once per instance per process: a heartbeat replaces the row,
   * and a restarted control plane (or another replica) must not move an instance's creation time.
   */
  private readonly firstSeen = new Map<string, number>();

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
      ...(record.watchers !== undefined ? { watchers: record.watchers } : {}),
      ...(record.stack !== undefined ? { stack: record.stack } : {}),
    };
    const firstSeenAt = await this.firstSeenOf(id, record.firstSeenAt);
    const row = {
      id,
      app: record.app,
      instance_id: record.instanceId,
      host: record.host,
      version: record.version,
      state: record.state,
      booted_at: record.bootedAt,
      first_seen_at: firstSeenAt,
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

  /** The stored `first_seen_at` of row `id` (the earlier of it and `candidate`), cached. */
  private async firstSeenOf(id: string, candidate: number): Promise<number> {
    const cached = this.firstSeen.get(id);
    if (cached !== undefined) return earliest(cached, candidate);
    const stored = await runAsTelescopeWork(() =>
      this.db.from(this.table).where('id', id).select('first_seen_at'),
    );
    const value = stored[0]?.first_seen_at;
    const first =
      value === null || value === undefined ? candidate : earliest(toInt(value), candidate);
    this.firstSeen.set(id, first);
    if (this.firstSeen.size > 10_000) {
      this.firstSeen.delete(this.firstSeen.keys().next().value as string);
    }
    return first;
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
        ...(watchersOf(payload.watchers) ?? {}),
        ...(normalizeStack(payload.stack) !== undefined
          ? { stack: normalizeStack(payload.stack) as StackEntry[] }
          : {}),
      };
    });
  }

  async prune(before: number): Promise<number> {
    await this.init();
    const removed = toInt(
      await runAsTelescopeWork(() =>
        this.db.from(this.table).where('last_seen_at', '<', before).delete(),
      ),
    );
    // A pruned instance that comes back is a new row: re-read what is stored. A prune that deleted
    // nothing (the usual case) keeps the cache, so it costs no re-read per instance.
    if (removed > 0) this.firstSeen.clear();
    return removed;
  }
}
