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

  it('não chama /queues/live quando o servidor diz que não há queue manager', async () => {
    const liveQueues = vi.fn().mockResolvedValue({ queues: [] });
    const meta = vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      queueManager: { enabled: false },
    });
    renderOverview(
      client({
        liveQueues: liveQueues as unknown as TelescopeClient['liveQueues'],
        meta: meta as unknown as TelescopeClient['meta'],
      }),
    );

    await waitFor(() => expect(screen.getByText('Failed jobs')).toBeTruthy());
    await waitFor(() => expect(meta).toHaveBeenCalled());
    expect(liveQueues).not.toHaveBeenCalled();
  });

  it('sem queue manager, o tile "Failed jobs" diz que não mede em vez de ficar no skeleton', async () => {
    const meta = vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      watchers: ['request'],
      queueManager: { enabled: false },
    });
    renderOverview(client({ meta: meta as unknown as TelescopeClient['meta'] }));

    await waitFor(() => expect(screen.getByText('not measured · no queue manager')).toBeTruthy());
    const tile = screen.getByText('Failed jobs').parentElement;
    expect(tile?.getAttribute('aria-busy')).toBeNull();
    expect(tile?.textContent).toContain('—');
  });

  it('o tile "Failed jobs" sai do skeleton quando /queues/live falha', async () => {
    renderOverview(
      client({ liveQueues: vi.fn().mockRejectedValue(new Error('queues fora do ar')) }),
    );

    await waitFor(() => expect(screen.getByText('could not load queues')).toBeTruthy());
  });

  it('com queue manager, o tile mostra a soma de falhas', async () => {
    const meta = vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      queueManager: { enabled: true },
    });
    const liveQueues = vi.fn().mockResolvedValue({
      queues: [
        { queue: 'a', counts: { failed: 2 } },
        { queue: 'b', counts: { failed: 1 } },
      ],
    });
    renderOverview(
      client({
        meta: meta as unknown as TelescopeClient['meta'],
        liveQueues: liveQueues as unknown as TelescopeClient['liveQueues'],
      }),
    );

    await waitFor(() =>
      expect(screen.getByText('Failed jobs').parentElement?.textContent).toContain('3'),
    );
  });

  it('chama /queues/live quando o queue manager está configurado', async () => {
    const liveQueues = vi.fn().mockResolvedValue({ queues: [] });
    const meta = vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      queueManager: { enabled: true },
    });
    renderOverview(
      client({
        liveQueues: liveQueues as unknown as TelescopeClient['liveQueues'],
        meta: meta as unknown as TelescopeClient['meta'],
      }),
    );

    await waitFor(() => expect(liveQueues).toHaveBeenCalled());
  });
});
