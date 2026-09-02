import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryType } from '../../src/entry.js';
import { MetricsService } from '../../src/metrics/metrics_service.js';
import type { TelescopeStore } from '../../src/store.js';
import { InMemoryTelescopeStore } from '../../src/stores/memory.js';

/**
 * O gráfico de throughput precisa de DOIS campos — `createdAt` e `type` — mas o
 * único jeito de obtê-los era `list()`, que faz `select('*')`: para desenhar
 * sessenta barras, o banco mandava cada entry da janela inteira, com o blob de
 * `content`, para tudo ser descartado menos um timestamp e uma string.
 *
 * Estes testes prendem as duas coisas que importam: o caminho rápido devolve
 * EXATAMENTE o mesmo gráfico que o caminho antigo, e o caminho antigo continua
 * existindo para stores que não implementem a capacidade.
 */
describe('getTimeseries — push-down por bucket', () => {
  // O tempo é CONGELADO porque o índice do bucket é relativo à origem da janela, e a
  // origem é `Date.now()` no momento da chamada. Comparar dois caminhos chamados em
  // instantes diferentes move entries entre buckets vizinhos por alguns milissegundos
  // de diferença — instável por construção, independente de folga.
  const NOW = new Date('2026-09-02T12:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Semeia `count` entries espaçadas dentro da janela, alternando o tipo. */
  async function seed(store: InMemoryTelescopeStore, count: number) {
    const now = NOW.getTime();
    for (let i = 0; i < count; i += 1) {
      const entry = await store.record({
        type: i % 2 === 0 ? EntryType.Request : EntryType.Redis,
        content: { blob: 'x'.repeat(200) },
        durationMs: 1,
      });
      // Espalhadas pela janela, para cair em buckets diferentes.
      entry.createdAt = new Date(now - 1_000 - i * 1_000);
    }
  }

  /** O mesmo store, sem a capacidade nova — um store de terceiro escrito antes dela. */
  function legacy(store: InMemoryTelescopeStore): TelescopeStore {
    return {
      record: (input) => store.record(input),
      get: (id) => store.get(id),
      list: (query) => store.list(query),
      count: () => store.count(),
      prune: (olderThan, keepLast) => store.prune(olderThan, keepLast),
      clear: () => store.clear(),
    };
  }

  it('caminho rápido e fallback produzem o MESMO gráfico', async () => {
    const store = new InMemoryTelescopeStore();
    await seed(store, 40);

    const fast = await new MetricsService(store).getTimeseries({ windowMs: 60_000, buckets: 10 });
    const slow = await new MetricsService(legacy(store)).getTimeseries({
      windowMs: 60_000,
      buckets: 10,
    });

    expect(fast.bucketMs).toBe(slow.bucketMs);
    expect(fast.buckets.map((b) => b.total)).toEqual(slow.buckets.map((b) => b.total));
    expect(fast.buckets.map((b) => b.byType)).toEqual(slow.buckets.map((b) => b.byType));
  });

  it('o filtro por tipo vale nos dois caminhos', async () => {
    const store = new InMemoryTelescopeStore();
    await seed(store, 20);

    const fast = await new MetricsService(store).getTimeseries({
      windowMs: 60_000,
      buckets: 5,
      type: EntryType.Request,
    });
    const slow = await new MetricsService(legacy(store)).getTimeseries({
      windowMs: 60_000,
      buckets: 5,
      type: EntryType.Request,
    });

    expect(fast.buckets.map((b) => b.total)).toEqual(slow.buckets.map((b) => b.total));
    // E de fato excluiu o outro tipo.
    for (const bucket of fast.buckets) {
      expect(bucket.byType[EntryType.Redis]).toBeUndefined();
    }
  });

  it('NÃO carrega as entries quando o store sabe contar', async () => {
    // É o ponto do commit: nenhuma linha completa sai do store para desenhar o gráfico.
    const store = new InMemoryTelescopeStore();
    await seed(store, 30);

    let listCalls = 0;
    const spied = Object.create(store) as InMemoryTelescopeStore;
    spied.list = async (query = {}) => {
      listCalls += 1;
      return store.list(query);
    };

    await new MetricsService(spied).getTimeseries({ windowMs: 60_000, buckets: 10 });
    expect(listCalls).toBe(0);
  });

  it('janela vazia devolve os buckets zerados, não uma lista curta', async () => {
    // O eixo x tem que existir mesmo sem tráfego, senão o gráfico "some".
    const store = new InMemoryTelescopeStore();
    const report = await new MetricsService(store).getTimeseries({ windowMs: 60_000, buckets: 8 });
    expect(report.buckets).toHaveLength(8);
    expect(report.buckets.every((b) => b.total === 0)).toBe(true);
  });
});
