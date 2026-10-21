import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import type { Entry } from '../src/entry.js';
import type {
  BucketCountQuery,
  BucketCountRow,
  EntryQuery,
  TraceIdQuery,
  TraceIdRow,
} from '../src/store.js';
import {
  type ParquetEngineConfig,
  type ParquetLocationConfig,
  storage,
} from '../src/stores/factory.js';
import type { ParquetColdStore } from '../src/stores/parquet.js';

export const ENGINES: ParquetEngineConfig[] = ['hyparquet', 'duckdb'];

export const fakeApp = { app: {} as ApplicationService };

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openCold(
  location: ParquetLocationConfig,
  engine: ParquetEngineConfig,
  extra: { rowGroupSize?: number; maxRowsPerFile?: number } = {},
): Promise<ParquetColdStore> {
  return storage.parquet({ location, engine, instanceId: 'test-pod', ...extra })(fakeApp);
}

const TYPES = ['request', 'query', 'exception'] as const;

/**
 * A deterministic spread of entries over `hours` UTC hours ending at `endMs`: three
 * types, tags, traces, families, null durations, and duplicate timestamps so the
 * tiebreakers are exercised.
 */
export function makeEntries(count: number, endMs: number, hours = 3): Entry[] {
  const spanMs = hours * 3_600_000;
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    // Pairs of entries share a millisecond, so the tiebreakers are exercised.
    const step = Math.floor(spanMs / Math.ceil(count / 2));
    const at = endMs - spanMs + Math.floor(i / 2) * step;
    const type = TYPES[i % TYPES.length]!;
    out.push({
      id: `e-${String(i).padStart(6, '0')}`,
      type,
      familyHash: i % 4 === 0 ? `fam-${i % 3}` : null,
      content: { n: i, url: `/path/${i % 7}`, note: i % 11 === 0 ? 'Needle Inside' : 'plain' },
      tags: [`lib:${i % 2 === 0 ? 'billing' : 'bill'}`, `status:${i % 5 === 0 ? 500 : 200}`],
      sequence: i,
      durationMs: i % 6 === 0 ? null : i % 300,
      origin: i % 2 === 0 ? 'http' : 'queue',
      traceId: i % 9 === 0 ? null : `trace-${i % 40}`,
      createdAt: new Date(Math.min(at, endMs - 1)),
    });
  }
  return out;
}

/** Reference semantics of every query field, independent of the stores under test. */
export function referenceList(entries: Entry[], query: EntryQuery): Entry[] {
  const needle = query.search?.toLowerCase();
  const matches = entries
    .filter((e) => query.type === undefined || e.type === query.type)
    .filter((e) => query.tag === undefined || e.tags.includes(query.tag))
    .filter((e) => query.familyHash === undefined || e.familyHash === query.familyHash)
    .filter((e) => query.traceId === undefined || e.traceId === query.traceId)
    .filter(
      (e) =>
        query.traceIds === undefined || (e.traceId !== null && query.traceIds.includes(e.traceId)),
    )
    .filter((e) => query.before === undefined || e.createdAt < query.before)
    .filter((e) => query.after === undefined || e.createdAt > query.after)
    .filter(
      (e) =>
        needle === undefined ||
        JSON.stringify(e.content).toLowerCase().includes(needle) ||
        JSON.stringify(e.tags).toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.sequence - a.sequence ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  if (query.size === undefined) return matches;
  const offset = (Math.max(1, query.page ?? 1) - 1) * query.size;
  return matches.slice(offset, offset + query.size);
}

export function referenceTraceIds(entries: Entry[], query: TraceIdQuery): TraceIdRow[] {
  const last = new Map<string, number>();
  for (const e of entries) {
    if (e.traceId === null) continue;
    if (query.before && !(e.createdAt < query.before)) continue;
    if (query.after && !(e.createdAt > query.after)) continue;
    last.set(e.traceId, Math.max(last.get(e.traceId) ?? 0, e.createdAt.getTime()));
  }
  const offset = (Math.max(1, query.page ?? 1) - 1) * query.size;
  return [...last.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(offset, offset + query.size)
    .map(([traceId, at]) => ({ traceId, lastAt: new Date(at) }));
}

export function referenceBuckets(entries: Entry[], query: BucketCountQuery): BucketCountRow[] {
  const tally = new Map<string, BucketCountRow>();
  for (const e of entries) {
    const at = e.createdAt.getTime();
    if (at <= query.after.getTime() || at > query.before.getTime()) continue;
    if (query.type !== undefined && e.type !== query.type) continue;
    const index = Math.floor((at - query.after.getTime()) / query.bucketMs);
    const key = `${index}|${e.type}`;
    const row = tally.get(key) ?? { index, type: e.type, count: 0 };
    row.count++;
    tally.set(key, row);
  }
  return sortBuckets([...tally.values()]);
}

export function sortBuckets(rows: BucketCountRow[]): BucketCountRow[] {
  return [...rows].sort((a, b) => a.index - b.index || a.type.localeCompare(b.type));
}

/** Trace rows compared by the set of (traceId, lastAt) — ties in lastAt may order either way. */
export function traceKey(rows: TraceIdRow[]): string[] {
  return rows.map((r) => `${r.traceId}@${r.lastAt.getTime()}`).sort();
}

export function ids(entries: Entry[]): string[] {
  return entries.map((e) => e.id);
}
