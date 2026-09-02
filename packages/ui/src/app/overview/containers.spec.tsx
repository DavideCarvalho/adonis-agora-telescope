import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../../client/telescope-client.js';
import { OverviewSection } from '../OverviewSection.js';
import { TelescopeQueryProvider } from '../query-provider.js';
import { TelescopeClientContext } from '../use-telescope.js';

const pulseSummary = {
  windowMs: 3_600_000,
  counts: { request: 10 },
  requests: { total: 10, errorRate: 0, status: { '2xx': 10, '3xx': 0, '4xx': 0, '5xx': 0 } },
  slowRoutes: [{ route: 'GET /slow', p99: 900, count: 3 }],
  slowest: [],
  topExceptions: [],
  nPlusOne: [],
  slowJobs: [],
  loadByUser: [],
} as unknown as Awaited<ReturnType<TelescopeClient['pulse']>>;

function client(overrides: Partial<TelescopeClient> = {}): TelescopeClient {
  return {
    pulse: vi.fn().mockResolvedValue(pulseSummary),
    liveQueues: vi.fn().mockResolvedValue({ queues: [] }),
    metricsTimeseries: vi.fn().mockResolvedValue({ buckets: [] }),
    retention: vi
      .fn()
      .mockResolvedValue({ enabled: true, afterMs: 1000, intervalMs: 1000, sampling: [] }),
    ...overrides,
  } as unknown as TelescopeClient;
}

function renderOverview(c: TelescopeClient): void {
  const noop = vi.fn();
  const ui: ReactNode = (
    <OverviewSection
      onOpenTrace={noop}
      onOpenEntry={noop}
      onOpenQueues={noop}
      onOpenPulse={noop}
      onOpenExceptions={noop}
      onOpenType={noop}
    />
  );
  render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={c}>{ui}</TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
}

/**
 * A página do Overview passou a ser só layout: cada painel busca o próprio dado e tem
 * o próprio loading. Estes testes prendem as duas propriedades que motivaram o
 * refactor — e que voltariam calados se alguém reintroduzisse um AsyncBlock no topo.
 */
describe('Overview — containers', () => {
  it('um painel LENTO não segura os outros', async () => {
    // pulse nunca resolve; as filas resolvem na hora.
    const never = new Promise(() => {});
    renderOverview(
      client({ pulse: vi.fn().mockReturnValue(never) as unknown as TelescopeClient['pulse'] }),
    );

    // O tile de filas aparece mesmo com o pulse pendurado. Antes, um único
    // AsyncBlock sobre o pulse deixava a grade inteira em skeleton.
    await waitFor(() => expect(screen.getByText('Failed jobs')).toBeTruthy());
    expect(screen.getByText('across queues')).toBeTruthy();
  });

  it('um painel que FALHA não derruba a página', async () => {
    renderOverview(
      client({
        liveQueues: vi.fn().mockRejectedValue(new Error('queues fora do ar')),
      }),
    );

    // O erro fica contido no painel dele; o resto da página segue renderizando.
    await waitFor(() => expect(screen.getByText('Requests')).toBeTruthy());
    expect(screen.getByText('Slow routes')).toBeTruthy();
  });

  it('containers que leem a MESMA fonte compartilham uma request', async () => {
    // Seis painéis/tiles do Overview leem `pulse`. Sem dedup, dividir a página em
    // containers multiplicaria as requests em vez de paralelizá-las — que é o
    // motivo de o react-query estar aqui.
    const pulse = vi.fn().mockResolvedValue(pulseSummary);
    renderOverview(client({ pulse: pulse as unknown as TelescopeClient['pulse'] }));

    await waitFor(() => expect(screen.getByText('Slow routes')).toBeTruthy());
    expect(pulse).toHaveBeenCalledTimes(1);
  });
});
