import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { PulseSummary } from '../client/types.js';
import { PulseSection } from './PulseSection.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

const pulseSummary: PulseSummary = {
  windowStart: '2026-07-13T09:00:00.000Z',
  windowEnd: '2026-07-13T10:00:00.000Z',
  windowMs: 3_600_000,
  counts: { request: 10 },
  throughput: {
    total: 10,
    perMinute: 0.5,
    overTime: { windowStart: '', windowEnd: '', bucketMs: 60000, buckets: [] },
  },
  requests: {
    total: 10,
    errorRate: 0,
    status: { '2xx': 10, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
    latency: { count: 10, p50: 5, p95: 10, p99: 12, max: 20, slow: 0 },
  },
  slowest: [],
  slowRoutes: [],
  slowOutgoing: [],
  slowJobs: [],
  topExceptions: [],
  nPlusOne: [],
  loadByUser: [],
  scanned: 10,
  truncated: false,
};

function renderPulse(watchers: string[] | undefined): void {
  const client = {
    pulse: vi.fn().mockResolvedValue(pulseSummary),
    meta: vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      ai: { enabled: false },
      ...(watchers === undefined ? {} : { watchers }),
    }),
  } as unknown as TelescopeClient;

  render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client}>
        <PulseSection onOpenTrace={vi.fn()} />
      </TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
}

/**
 * "No N+1 loops detected." e "the query watcher is off" são afirmações OPOSTAS, e o
 * console vinha fazendo a primeira quando a segunda era verdade — relatando a
 * própria cegueira na voz de boa notícia. O leitor sai tranquilizado sobre algo que
 * ninguém mediu.
 *
 * Em produção era exatamente o caso: zero entries `query` (o Lucid só emite
 * `db:query` com `debug` ligado) e o watcher `http-client` nem estava na lista.
 */
describe('painéis que dependem de watcher opcional', () => {
  it('watcher DESLIGADO: diz que não está medindo, e qual watcher falta', async () => {
    renderPulse(['request', 'redis']);
    await waitFor(() => expect(screen.getAllByText(/Not measured/).length).toBe(2));
    expect(screen.getAllByText('query').length).toBeGreaterThan(0);
    expect(screen.getAllByText('http-client').length).toBeGreaterThan(0);
    // E não afirma saúde.
    expect(screen.queryByText('No N+1 loops detected.')).toBeNull();
    expect(screen.queryByText('No slow outgoing calls.')).toBeNull();
  });

  it('watcher LIGADO e sem achados: aí sim pode dizer que não achou nada', async () => {
    renderPulse(['request', 'query', 'http-client']);
    await waitFor(() => expect(screen.getByText('No N+1 loops detected.')).toBeTruthy());
    expect(screen.getByText('No slow outgoing calls.')).toBeTruthy();
    expect(screen.queryByText(/Not measured/)).toBeNull();
  });

  it('servidor ANTIGO (sem o campo) não vira uma segunda afirmação errada', async () => {
    // Sem `watchers` no /meta não dá pra saber, e afirmar "desligado" seria trocar
    // uma resposta confiante errada por outra. Mantém o texto antigo.
    renderPulse(undefined);
    await waitFor(() => expect(screen.getByText('No N+1 loops detected.')).toBeTruthy());
    expect(screen.queryByText(/Not measured/)).toBeNull();
  });
});
