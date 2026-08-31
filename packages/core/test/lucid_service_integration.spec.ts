import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelescopeService } from '../src/service.js';
import { LucidTelescopeStore } from '../src/stores/lucid.js';
import { makeHarness, type TestHarness } from './lucid_helpers.js';

let harness: TestHarness;
let store: LucidTelescopeStore;
let service: TelescopeService;

beforeEach(async () => {
  harness = await makeHarness();
  store = new LucidTelescopeStore(harness.lucid, { autoCreateTable: true });
  service = new TelescopeService(store);

  await store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'billing:paid',
    tags: ['lib:billing', 'event:paid'],
    traceId: 't1',
  });
  await store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'billing:paid',
    tags: ['lib:billing', 'event:paid'],
    traceId: 't1',
  });
  await store.record({
    type: 'request',
    content: {},
    tags: ['method:GET', 'status:200'],
    traceId: 't1',
  });
  await store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'mailer:sent',
    tags: ['lib:mailer'],
    traceId: 't2',
  });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('TelescopeService over LucidTelescopeStore (async end-to-end)', () => {
  it('lists and finds entries', async () => {
    expect(await service.count()).toBe(4);
    expect(await service.list({ type: 'request' })).toHaveLength(1);
    const id = (await service.list())[0]?.id as string;
    expect((await service.find(id))?.id).toBe(id);
    expect(await service.find('absent')).toBeNull();
  });

  it('byTrace returns all entries of a trace', async () => {
    expect(await service.byTrace('t1')).toHaveLength(3);
    expect(await service.byTrace('t2')).toHaveLength(1);
  });

  it('topFamilies ranks busiest grouping keys', async () => {
    const top = await service.topFamilies(10, 'diagnostic');
    expect(top[0]).toEqual({ key: 'billing:paid', count: 2 });
    expect(top.find((b) => b.key === 'mailer:sent')?.count).toBe(1);
  });

  it('topTags ranks common tags, honouring a prefix', async () => {
    const libs = await service.topTags(10, 'lib:');
    expect(libs.find((b) => b.key === 'lib:billing')?.count).toBe(2);
    expect(libs.every((b) => b.key.startsWith('lib:'))).toBe(true);
  });
});
