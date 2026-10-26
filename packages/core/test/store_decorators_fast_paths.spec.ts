import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../src/metrics/metrics_service.js';
import type { OtelExporter } from '../src/otel/otel_exporter.js';
import { OtelExportingTelescopeStore } from '../src/otel/otel_exporting_store.js';
import { RedactingTelescopeStore } from '../src/redaction/redacting_store.js';
import { SamplingTelescopeStore } from '../src/sampling/sampling_store.js';
import { TelescopeService } from '../src/service.js';
import type { TelescopeStore } from '../src/store.js';
import { InMemoryTelescopeStore } from '../src/stores/memory.js';
import { EntryEvents } from '../src/stream/entry_events.js';
import { StreamingTelescopeStore } from '../src/stream/streaming_store.js';

const exporter = { exportSpan: () => {}, exportLog: () => {} } as unknown as OtelExporter;

const DECORATORS: Array<[string, (inner: TelescopeStore) => TelescopeStore]> = [
  ['redacting', (inner) => new RedactingTelescopeStore(inner)],
  ['sampling', (inner) => new SamplingTelescopeStore(inner, {})],
  ['streaming', (inner) => new StreamingTelescopeStore(inner, new EntryEvents())],
  ['otel', (inner) => new OtelExportingTelescopeStore(inner, exporter, ['request'])],
];

const OPTIONAL = ['listTraceIds', 'countByBucket', 'countFamilies', 'countTags'] as const;

/** A store with only the required methods. */
function minimalStore(): TelescopeStore {
  const inner = new InMemoryTelescopeStore();
  return {
    record: (input) => inner.record(input),
    get: (id) => inner.get(id),
    list: (query) => inner.list(query),
    count: () => inner.count(),
    prune: (olderThan, keepLast) => inner.prune(olderThan, keepLast),
    clear: () => inner.clear(),
  };
}

describe.each(DECORATORS)('%s store decorator', (_name, decorate) => {
  it("exposes the inner store's optional reads, delegating to it", async () => {
    const inner = new InMemoryTelescopeStore();
    await inner.record({ type: 'query', familyHash: 'f', content: {}, tags: ['t'], traceId: 'x' });
    const spy = vi.spyOn(inner, 'countFamilies');
    const store = decorate(inner);

    for (const name of OPTIONAL) expect(typeof store[name]).toBe('function');
    expect(await store.countFamilies!({ limit: 5 })).toEqual([{ key: 'f', count: 1 }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await store.countTags!({ limit: 5 })).toEqual([{ key: 't', count: 1 }]);
    expect(await store.listTraceIds!({ size: 5 })).toHaveLength(1);
  });

  it('does not claim optional reads the inner store lacks', () => {
    const store = decorate(minimalStore());
    for (const name of OPTIONAL) expect(store[name]).toBeUndefined();
  });

  it('lets the throughput chart use the fast path through the decorator', async () => {
    const inner = new InMemoryTelescopeStore();
    await inner.record({ type: 'query', content: {} });
    const list = vi.spyOn(inner, 'list');
    const countByBucket = vi.spyOn(inner, 'countByBucket');

    await new MetricsService(decorate(inner)).getTimeseries({ windowMs: 60_000 });

    expect(countByBucket).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('lets /api/stats count through the decorator instead of listing every entry', async () => {
    const inner = new InMemoryTelescopeStore();
    await inner.record({ type: 'query', familyHash: 'f', content: {}, tags: ['t'] });
    const list = vi.spyOn(inner, 'list');
    const service = new TelescopeService(decorate(inner));

    expect(await service.topFamilies(10)).toEqual([{ key: 'f', count: 1 }]);
    expect(await service.topTags(10)).toEqual([{ key: 't', count: 1 }]);
    expect(list).not.toHaveBeenCalled();
  });
});
