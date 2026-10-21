import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '../src/entry.js';
import type { EntryQuery } from '../src/store.js';
import type { ParquetColdStore } from '../src/stores/parquet.js';
import { importOptionalPeer } from '../src/stores/parquet_location.js';
import {
  ENGINES,
  ids,
  makeEntries,
  openCold,
  referenceBuckets,
  referenceList,
  referenceTraceIds,
  sortBuckets,
  tempDir,
  traceKey,
} from './parquet_helpers.js';

const END = Date.UTC(2026, 9, 20, 12, 30);
const HOUR = 3_600_000;

function parquetFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.parquet')) out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

describe.each(ENGINES)('parquet cold store (%s engine, local dir)', (engine) => {
  let tmp: ReturnType<typeof tempDir>;
  let cold: ParquetColdStore;
  let entries: Entry[];

  beforeEach(async () => {
    tmp = tempDir('telescope-parquet-');
    cold = await openCold({ dir: tmp.dir }, engine, { rowGroupSize: 100 });
    entries = makeEntries(3000, END, 3);
    // Three writes, so every partition holds several files from "different cycles".
    await cold.write(entries.slice(0, 1000));
    await cold.write(entries.slice(1000, 2200));
    await cold.write(entries.slice(2200));
  });

  afterEach(async () => {
    await cold.close();
    tmp.cleanup();
  });

  it('lays files out as type=/dt=/hour=/<instance>-<uuid>.parquet', () => {
    const rel = parquetFiles(tmp.dir).map((f) => f.slice(tmp.dir.length + 1));
    expect(rel.length).toBeGreaterThan(9);
    for (const key of rel) {
      expect(key).toMatch(
        /^type=(request|query|exception)\/dt=2026-10-20\/hour=(09|10|11|12)\/test-pod-[0-9a-f-]{36}\.parquet$/,
      );
    }
  });

  const queries: Array<[string, EntryQuery]> = [
    ['everything', {}],
    ['first page', { size: 50 }],
    ['deep page', { page: 7, size: 113 }],
    ['type', { type: 'query', size: 40 }],
    ['type, page 3', { type: 'exception', page: 3, size: 25 }],
    ['tag (exact token)', { tag: 'lib:bill', size: 30 }],
    ['familyHash', { familyHash: 'fam-1' }],
    ['traceId', { traceId: 'trace-7' }],
    ['traceIds', { traceIds: ['trace-1', 'trace-2', 'trace-3'], size: 20 }],
    ['empty traceIds', { traceIds: [] }],
    ['search (content, case-insensitive)', { search: 'needle inside', size: 15 }],
    ['search (tags)', { search: 'STATUS:500', size: 15 }],
    ['before', { before: new Date(END - 90 * 60_000), size: 60 }],
    ['after', { after: new Date(END - 20 * 60_000) }],
    [
      'window + type',
      {
        type: 'request',
        after: new Date(END - 2 * HOUR),
        before: new Date(END - HOUR),
        page: 2,
        size: 33,
      },
    ],
    ['past the end', { page: 1000, size: 50 }],
  ];

  it.each(queries)('list: %s matches the reference', async (_name, query) => {
    expect(ids(await cold.list(query))).toEqual(ids(referenceList(entries, query)));
  });

  it('round-trips every field', async () => {
    const [newest] = await cold.list({ size: 1 });
    const expected = referenceList(entries, { size: 1 })[0]!;
    expect(newest).toEqual(expected);
  });

  it('gets by id, and null for an unknown id', async () => {
    const target = entries[1234]!;
    expect(await cold.get(target.id)).toEqual(target);
    expect(await cold.get('nope')).toBeNull();
  });

  it('counts from footers', async () => {
    expect(await cold.count()).toBe(entries.length);
  });

  it('lists trace ids most-recently-seen first, paged', async () => {
    const all = await cold.listTraceIds({ size: 100 });
    expect(traceKey(all)).toEqual(traceKey(referenceTraceIds(entries, { size: 100 })));
    const page2 = await cold.listTraceIds({ size: 7, page: 2, before: new Date(END - HOUR) });
    expect(page2.map((r) => r.lastAt.getTime())).toEqual(
      referenceTraceIds(entries, { size: 7, page: 2, before: new Date(END - HOUR) }).map((r) =>
        r.lastAt.getTime(),
      ),
    );
  });

  it('counts by bucket', async () => {
    const query = { after: new Date(END - 2.5 * HOUR), before: new Date(END), bucketMs: 600_000 };
    expect(sortBuckets(await cold.countByBucket(query))).toEqual(referenceBuckets(entries, query));
    const typed = { ...query, type: 'query' };
    expect(sortBuckets(await cold.countByBucket(typed))).toEqual(referenceBuckets(entries, typed));
  });

  it('expires whole hours older than the cutoff', async () => {
    // Cutoff in the middle of hour 11: hours 09 and 10 are fully older, 11 is not.
    const cutoff = new Date(Date.UTC(2026, 9, 20, 11, 30));
    const doomed = entries.filter((e) => e.createdAt.getTime() < Date.UTC(2026, 9, 20, 11));
    expect(await cold.expire(cutoff)).toBe(doomed.length);
    const left = entries.filter((e) => e.createdAt.getTime() >= Date.UTC(2026, 9, 20, 11));
    expect(ids(await cold.list())).toEqual(ids(referenceList(left, {})));
  });

  it('honours keepLast at file granularity when expiring', async () => {
    const cutoff = new Date(END + HOUR);
    await cold.expire(cutoff, 500);
    const remaining = await cold.count();
    expect(remaining).toBeGreaterThanOrEqual(500);
    expect(remaining).toBeLessThan(entries.length);
    // What is kept is the newest data.
    expect(ids(await cold.list({ size: 50 }))).toEqual(ids(referenceList(entries, { size: 50 })));
  });

  it('compacts each closed hour into one file without changing results', async () => {
    const before = parquetFiles(tmp.dir).length;
    const replaced = await cold.compact(new Date(END + HOUR));
    expect(replaced).toBeGreaterThan(0);
    const after = parquetFiles(tmp.dir);
    expect(after.length).toBeLessThan(before);
    // Default 4 partitions per run; run until stable.
    while ((await cold.compact(new Date(END + HOUR))) > 0) {}
    const byPartition = new Map<string, number>();
    for (const file of parquetFiles(tmp.dir)) {
      const dir = file.slice(0, file.lastIndexOf('/'));
      byPartition.set(dir, (byPartition.get(dir) ?? 0) + 1);
    }
    expect([...byPartition.values()].every((n) => n === 1)).toBe(true);
    expect(ids(await cold.list())).toEqual(ids(referenceList(entries, {})));
    expect(await cold.count()).toBe(entries.length);
  });

  it('treats a file deleted under it as empty instead of failing', async () => {
    await cold.list({ size: 1 }); // warm the listing cache
    const victim = parquetFiles(tmp.dir)[0]!;
    rmSync(victim);
    const rows = await cold.list();
    expect(rows.length).toBeLessThan(entries.length);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('leaves no unhandled rejection behind when files vanish mid-read', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      // Filtered reads prefetch several byte ranges per file at once; a file deleted
      // after its footer is cached fails all of them, and only the first is awaited.
      await cold.list();
      for (const file of parquetFiles(tmp.dir)) rmSync(file);
      await cold.list({ type: 'query' });
      await cold.get(entries[0]!.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('clears every file', async () => {
    await cold.clear();
    expect(parquetFiles(tmp.dir)).toHaveLength(0);
    expect(await cold.list()).toEqual([]);
  });
});

describe('optional peers', () => {
  it('names the missing package and the config that needs it', async () => {
    const missing = Object.assign(new Error("Cannot find package '@duckdb/node-api'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await expect(
      importOptionalPeer('@duckdb/node-api', "storage.parquet({ engine: 'duckdb' })", () =>
        Promise.reject(missing),
      ),
    ).rejects.toThrow(
      /storage\.parquet\(\{ engine: 'duckdb' \}\) needs the optional peer dependency "@duckdb\/node-api"/,
    );
  });

  it('rethrows other load failures untouched', async () => {
    const broken = new Error('invalid ELF header');
    await expect(
      importOptionalPeer('@duckdb/node-api', 'x', () => Promise.reject(broken)),
    ).rejects.toBe(broken);
  });
});
