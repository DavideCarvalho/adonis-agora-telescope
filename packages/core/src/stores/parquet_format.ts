import { type Entry, isBatchOrigin } from '../entry.js';
import type { EntryQuery } from '../store.js';

/** One hour, in ms. Partitions are hourly. */
export const HOUR_MS = 3_600_000;

/**
 * The on-disk row. `content` and `tags` are JSON text, exactly as the Lucid store keeps
 * them, so a tag match is the same quoted-token substring test in every engine and no
 * engine needs nested-type support. `created_at` is a millisecond TIMESTAMP so both the
 * row-group statistics and DuckDB see a real time column.
 */
export interface ParquetRow {
  id: string;
  type: string;
  family_hash: string | null;
  content: string;
  tags: string;
  sequence: bigint;
  duration_ms: bigint | null;
  origin: string;
  trace_id: string | null;
  instance_id: string;
  created_at: Date;
}

/** Column order and types, shared by the writer and the DuckDB projection. */
export const PARQUET_COLUMNS = [
  { name: 'id', type: 'STRING', nullable: false, bloomFilter: true },
  { name: 'type', type: 'STRING', nullable: false },
  { name: 'family_hash', type: 'STRING', nullable: true },
  { name: 'content', type: 'STRING', nullable: false },
  { name: 'tags', type: 'STRING', nullable: false },
  { name: 'sequence', type: 'INT64', nullable: false },
  { name: 'duration_ms', type: 'INT64', nullable: true },
  { name: 'origin', type: 'STRING', nullable: false },
  { name: 'trace_id', type: 'STRING', nullable: true, bloomFilter: true },
  { name: 'instance_id', type: 'STRING', nullable: false },
  { name: 'created_at', type: 'TIMESTAMP', nullable: false },
] as const;

export function toParquetRow(entry: Entry, instanceId: string): ParquetRow {
  return {
    id: entry.id,
    type: entry.type,
    family_hash: entry.familyHash,
    content: safeJson(entry.content),
    tags: JSON.stringify(entry.tags),
    sequence: BigInt(Math.trunc(entry.sequence)),
    duration_ms: entry.durationMs == null ? null : BigInt(Math.round(entry.durationMs)),
    origin: entry.origin,
    trace_id: entry.traceId,
    instance_id: instanceId,
    created_at: entry.createdAt,
  };
}

/** Rebuild an {@link Entry} from a row as either engine returns it. */
export function fromParquetRow(row: Record<string, unknown>): Entry {
  const duration = row.duration_ms;
  return {
    id: String(row.id),
    type: String(row.type),
    familyHash: row.family_hash == null ? null : String(row.family_hash),
    content: parseJson(String(row.content ?? 'null')),
    tags: parseTags(String(row.tags ?? '[]')),
    sequence: toNumber(row.sequence),
    durationMs: duration == null ? null : toNumber(duration),
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    traceId: row.trace_id == null ? null : String(row.trace_id),
    createdAt: toDate(row.created_at),
  };
}

/** A file's partition, parsed from its key. */
export interface PartitionKey {
  type: string;
  /** Start of the file's UTC hour, epoch ms. */
  hourStartMs: number;
}

/**
 * `type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/` — type first, so a query on one type (and a
 * bucket lifecycle rule on one type) only touches that type's prefix.
 */
export function partitionPrefix(type: string, hourStartMs: number): string {
  const d = new Date(hourStartMs);
  const dt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return `${typePrefix(type)}dt=${dt}/hour=${pad(d.getUTCHours())}/`;
}

export function typePrefix(type: string): string {
  return `type=${encodeURIComponent(type)}/`;
}

const KEY_PATTERN = /^type=([^/]+)\/dt=(\d{4})-(\d{2})-(\d{2})\/hour=(\d{2})\/[^/]+\.parquet$/;

/** Parse a location-relative key, or `null` for anything that is not ours. */
export function parsePartition(key: string): PartitionKey | null {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, type, y, m, d, h] = match;
  let decoded: string;
  try {
    decoded = decodeURIComponent(type!);
  } catch {
    return null;
  }
  return {
    type: decoded,
    hourStartMs: Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h)),
  };
}

export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Newest-first total order used by every tier: `createdAt` desc, then `sequence` desc
 * (the Lucid store's tiebreaker), then `id` desc so the order is total across pods.
 */
export function compareNewestFirst(a: Entry, b: Entry): number {
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  if (t !== 0) return t;
  if (a.sequence !== b.sequence) return b.sequence - a.sequence;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The `{ page, size }` of a query, resolved: how many to skip and how many to keep. */
export function resolvePage(query: EntryQuery): { offset: number; size: number | undefined } {
  if (query.size === undefined || query.size <= 0) return { offset: 0, size: undefined };
  const size = Math.floor(query.size);
  const page = Math.max(1, Math.floor(query.page ?? 1));
  return { offset: (page - 1) * size, size };
}

/**
 * The predicates of an {@link EntryQuery} that need the row itself (everything except
 * the time bounds and type, which partitions and statistics already prune). Applied
 * in JS by the hyparquet engine and as a final guard on merged results.
 */
export function matchesQuery(entry: Entry, query: EntryQuery): boolean {
  if (query.type !== undefined && entry.type !== query.type) return false;
  if (query.familyHash !== undefined && entry.familyHash !== query.familyHash) return false;
  if (query.traceId !== undefined && entry.traceId !== query.traceId) return false;
  if (query.traceIds !== undefined) {
    if (entry.traceId === null || !query.traceIds.includes(entry.traceId)) return false;
  }
  if (query.before !== undefined && !(entry.createdAt < query.before)) return false;
  if (query.after !== undefined && !(entry.createdAt > query.after)) return false;
  if (query.tag !== undefined && !entry.tags.includes(query.tag)) return false;
  if (query.search !== undefined) {
    const needle = query.search.toLowerCase();
    if (!entry.tags.some((tag) => tag.toLowerCase().includes(needle))) {
      if (!safeJson(entry.content).toLowerCase().includes(needle)) return false;
    }
  }
  return true;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseTags(text: string): string[] {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}

export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'bigint') return new Date(Number(value));
  if (typeof value === 'string') return new Date(value);
  return new Date(0);
}
