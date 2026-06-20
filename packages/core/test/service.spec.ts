import { describe, expect, it } from 'vitest';
import { TelescopeService } from '../src/service.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';

async function seed() {
  const store = new InMemoryTelescopeStore();
  const service = new TelescopeService(store);
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
  return { store, service };
}

describe('TelescopeService', () => {
  it('lists and finds entries', async () => {
    const { service } = await seed();
    expect(await service.count()).toBe(4);
    expect(await service.list({ type: 'request' })).toHaveLength(1);
    const id = (await service.list())[0]?.id as string;
    expect((await service.find(id))?.id).toBe(id);
    expect(await service.find('absent')).toBeNull();
  });

  it('byTrace returns all entries of a trace', async () => {
    const { service } = await seed();
    expect(await service.byTrace('t1')).toHaveLength(3);
    expect(await service.byTrace('t2')).toHaveLength(1);
  });

  it('topFamilies ranks busiest grouping keys', async () => {
    const { service } = await seed();
    const top = await service.topFamilies(10, 'diagnostic');
    expect(top[0]).toEqual({ key: 'billing:paid', count: 2 });
    expect(top.find((b) => b.key === 'mailer:sent')?.count).toBe(1);
  });

  it('topTags ranks common tags, honouring a prefix', async () => {
    const { service } = await seed();
    const libs = await service.topTags(10, 'lib:');
    expect(libs.find((b) => b.key === 'lib:billing')?.count).toBe(2);
    expect(libs.every((b) => b.key.startsWith('lib:'))).toBe(true);
  });

  it('exposes the underlying store', async () => {
    const { store, service } = await seed();
    expect(service.telescopeStore).toBe(store);
  });
});
