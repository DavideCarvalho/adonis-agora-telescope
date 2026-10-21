import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParquetColdStore } from '../src/stores/parquet.js';
import { ENGINES, ids, makeEntries, openCold, referenceList, tempDir } from './parquet_helpers.js';

/**
 * Runs against a real S3 API when `TELESCOPE_TEST_S3_ENDPOINT` is set, e.g. a MinIO
 * container:
 *
 *   docker run -d --name telescope-minio -p 19000:9000 minio/minio server /data
 *   TELESCOPE_TEST_S3_ENDPOINT=http://127.0.0.1:19000 pnpm test
 *
 * Credentials default to MinIO's `minioadmin` / `minioadmin`.
 */
const endpoint = process.env.TELESCOPE_TEST_S3_ENDPOINT;
const END = Date.UTC(2026, 9, 20, 12, 30);

describe.skipIf(!endpoint).each(ENGINES)('parquet cold store on S3 (%s engine)', (engine) => {
  const bucket = `telescope-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let client: S3Client;
  let cold: ParquetColdStore;
  let cache: ReturnType<typeof tempDir>;
  const entries = makeEntries(1500, END, 2);

  beforeAll(async () => {
    client = new S3Client({
      endpoint: endpoint!,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.TELESCOPE_TEST_S3_KEY ?? 'minioadmin',
        secretAccessKey: process.env.TELESCOPE_TEST_S3_SECRET ?? 'minioadmin',
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    cache = tempDir('telescope-s3-cache-');
    cold = await openCold(
      { s3: { client, bucket, prefix: 'telescope/v1' } },
      engine === 'duckdb' ? { duckdb: { cacheDir: cache.dir } } : engine,
      { rowGroupSize: 200 },
    );
    await cold.write(entries.slice(0, 700));
    await cold.write(entries.slice(700));
  });

  afterAll(async () => {
    await cold?.clear();
    await cold?.close();
    client?.destroy();
    cache?.cleanup();
  });

  it('writes under the prefix with the partition layout', async () => {
    const objects = await cold.location.list('');
    expect(objects.length).toBeGreaterThan(4);
    for (const object of objects) {
      expect(object.key).toMatch(
        /^type=[a-z]+\/dt=2026-10-20\/hour=1[0-2]\/test-pod-[0-9a-f-]+\.parquet$/,
      );
    }
  });

  it.each([
    ['newest page', { size: 50 }],
    ['deep page of a type', { type: 'query', page: 4, size: 40 }],
    ['tag', { tag: 'lib:billing', size: 30 }],
    ['search', { search: 'needle', size: 20 }],
    ['window', { after: new Date(END - 45 * 60_000), before: new Date(END - 15 * 60_000) }],
  ])('list: %s', async (_name, query) => {
    expect(ids(await cold.list(query))).toEqual(ids(referenceList(entries, query)));
  });

  it('gets by id and counts', async () => {
    expect(await cold.get(entries[321]!.id)).toEqual(entries[321]);
    expect(await cold.count()).toBe(entries.length);
  });

  it('compacts and expires on S3', async () => {
    while ((await cold.compact(new Date(END + 3_600_000))) > 0) {}
    expect(ids(await cold.list())).toEqual(ids(referenceList(entries, {})));
    const expired = await cold.expire(new Date(Date.UTC(2026, 9, 20, 12)));
    expect(expired).toBe(
      entries.filter((e) => e.createdAt.getTime() < Date.UTC(2026, 9, 20, 12)).length,
    );
  });
});
