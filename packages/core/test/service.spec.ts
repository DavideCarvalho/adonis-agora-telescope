import { describe, expect, it } from 'vitest';
import { InMemoryTelescopeStore } from '../src/in_memory_store.js';
import { TelescopeService } from '../src/service.js';

function seed() {
  const store = new InMemoryTelescopeStore();
  const service = new TelescopeService(store);
  store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'billing:paid',
    tags: ['lib:billing', 'event:paid'],
    traceId: 't1',
  });
  store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'billing:paid',
    tags: ['lib:billing', 'event:paid'],
    traceId: 't1',
  });
  store.record({
    type: 'request',
    content: {},
    tags: ['method:GET', 'status:200'],
    traceId: 't1',
  });
  store.record({
    type: 'diagnostic',
    content: {},
    familyHash: 'mailer:sent',
    tags: ['lib:mailer'],
    traceId: 't2',
  });
  return { store, service };
}

describe('TelescopeService', () => {
  it('lists and finds entries', () => {
    const { service } = seed();
    expect(service.count()).toBe(4);
    expect(service.list({ type: 'request' })).toHaveLength(1);
    const id = service.list()[0]?.id as string;
    expect(service.find(id)?.id).toBe(id);
    expect(service.find('absent')).toBeNull();
  });

  it('byTrace returns all entries of a trace', () => {
    const { service } = seed();
    expect(service.byTrace('t1')).toHaveLength(3);
    expect(service.byTrace('t2')).toHaveLength(1);
  });

  it('topFamilies ranks busiest grouping keys', () => {
    const { service } = seed();
    const top = service.topFamilies(10, 'diagnostic');
    expect(top[0]).toEqual({ key: 'billing:paid', count: 2 });
    expect(top.find((b) => b.key === 'mailer:sent')?.count).toBe(1);
  });

  it('topTags ranks common tags, honouring a prefix', () => {
    const { service } = seed();
    const libs = service.topTags(10, 'lib:');
    expect(libs.find((b) => b.key === 'lib:billing')?.count).toBe(2);
    expect(libs.every((b) => b.key.startsWith('lib:'))).toBe(true);
  });

  it('exposes the underlying store', () => {
    const { store, service } = seed();
    expect(service.telescopeStore).toBe(store);
  });
});
