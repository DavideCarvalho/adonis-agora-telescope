import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { FleetApp, FleetInstance, FleetView } from '../client/types.js';
import { FleetSection, humanDuration, instanceTimes } from './FleetSection.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { formatHash, parseHash } from './use-hash-route.js';
import { TelescopeClientContext } from './use-telescope.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const MIN = 60_000;

function instance(overrides: Partial<FleetInstance>): FleetInstance {
  return {
    app: 'shop',
    instanceId: 'i',
    environment: null,
    host: 'web-1',
    pid: 1,
    version: 'v1',
    bootedAt: NOW - 60 * MIN,
    firstSeenAt: NOW - 60 * MIN,
    lastSeenAt: NOW - 4000,
    state: 'ready',
    intervalMs: 15000,
    checks: [],
    shipping: null,
    status: 'up',
    uptimeMs: 60 * MIN,
    health: 'ok',
    ...overrides,
  };
}

const shop: FleetApp = {
  app: 'shop',
  counts: { up: 2, starting: 1, draining: 0, gone: 1 },
  versions: [
    { version: 'v2', instances: 2 },
    { version: 'v1', instances: 1 },
  ],
  instances: [
    instance({ instanceId: 'a', host: 'web-a', version: 'v2' }),
    instance({ instanceId: 'b', host: 'web-b', version: 'v2' }),
    instance({ instanceId: 'c', host: 'web-c', status: 'starting', state: 'starting' }),
    instance({ instanceId: 'd', host: 'worker-0', status: 'gone', lastSeenAt: NOW - 5 * MIN }),
  ],
  deploys: [
    {
      version: 'v2',
      previous: 'v1',
      startedAt: NOW - 6 * MIN,
      live: 2,
      total: 3,
      progress: 2 / 3,
      complete: false,
    },
  ],
  restartLoops: [{ host: 'worker-0', restarts: 4, since: NOW - 8 * MIN, lastBootAt: NOW - MIN }],
  checks: [
    {
      name: 'redis',
      status: 'down',
      since: NOW - 12 * MIN,
      message: 'OOM command not allowed',
      affected: 3,
      of: 3,
      critical: true,
      exceptions: [
        {
          familyHash: 'f1',
          class: 'ReplyError',
          message: 'OOM command not allowed',
          count: 30375,
          entryId: 'entry-1',
        },
      ],
    },
  ],
  shipping: { buffered: 40, dropped: 0, maxLagMs: 1200 },
};

function renderFleet(view: FleetView, onOpenEntry = vi.fn()) {
  const client = { fleet: vi.fn().mockResolvedValue(view) } as unknown as TelescopeClient;
  render(
    <TelescopeQueryProvider>
      <NuqsHashAdapter>
        <TelescopeClientContext.Provider value={client}>
          <FleetSection onOpenEntry={onOpenEntry} />
        </TelescopeClientContext.Provider>
      </NuqsHashAdapter>
    </TelescopeQueryProvider>,
  );
  return { client, onOpenEntry };
}

describe('Fleet page', () => {
  it('shows counts by state, instances, the deploy, the restart loop and the failing check', async () => {
    const { onOpenEntry } = renderFleet({
      enabled: true,
      notice: null,
      now: NOW,
      apps: [shop],
      self: null,
    });
    expect(await screen.findByText('shop')).toBeTruthy();
    for (const label of ['Up', 'Starting', 'Draining', 'Gone'])
      expect(screen.getByText(label)).toBeTruthy();
    for (const host of ['web-a', 'web-b', 'web-c']) expect(screen.getByText(host)).toBeTruthy();
    expect(screen.getByText('2/3 live')).toBeTruthy();
    expect(screen.getByTestId('fleet-restart-loop').textContent).toMatch(
      /worker-0\s*restarted 4 times in 8 min/,
    );
    const incident = screen.getByTestId('fleet-incident');
    expect(incident.textContent).toMatch(/Redis: down for 12 min/);
    expect(incident.textContent).toMatch(/on 3 of 3 instances/);
    fireEvent.click(screen.getByText('ReplyError'));
    expect(onOpenEntry).toHaveBeenCalledWith('entry-1');
  });

  it('shows each instance role and filters by role (web servers and workers)', async () => {
    const mixed: FleetApp = {
      ...shop,
      counts: { up: 2, starting: 0, draining: 1, gone: 0 },
      instances: [
        instance({ instanceId: 'w', host: 'web-a', role: 'web' }),
        instance({ instanceId: 'd', host: 'worker-a', role: 'durable:work' }),
        instance({
          instanceId: 'q',
          host: 'worker-b',
          role: 'queue:work',
          status: 'draining',
          state: 'draining',
        }),
      ],
      restartLoops: [
        {
          host: 'worker-a',
          role: 'durable:work',
          restarts: 3,
          since: NOW - 4 * MIN,
          lastBootAt: NOW,
        },
      ],
      checks: [],
    };
    renderFleet({ enabled: true, notice: null, now: NOW, apps: [mixed], self: null });
    expect(await screen.findByText('web-a')).toBeTruthy();
    expect(screen.getAllByTestId('fleet-role').map((b) => b.textContent)).toEqual([
      'web',
      'durable:work',
      'queue:work',
    ]);
    expect(screen.getByTestId('fleet-restart-loop').textContent).toMatch(
      /worker-a\s*\(durable:work\)\s*restarted 3 times/,
    );

    const filter = screen.getByRole('button', { name: 'queue:work' });
    expect(screen.getByRole('button', { name: 'All roles' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('web-a')).toBeNull();
    expect(screen.queryByTestId('fleet-restart-loop')).toBeNull();
    expect(screen.getAllByTestId('fleet-role').map((b) => b.textContent)).toEqual(['queue:work']);
    // Counts follow the filter: the queue worker is draining, nothing of that role is up.
    const card = (label: string) => screen.getByText(label).parentElement?.textContent ?? '';
    expect(card('Draining')).toMatch(/1/);
    expect(card('Up')).toMatch(/0/);

    fireEvent.click(screen.getByRole('button', { name: 'All roles' }));
    expect(screen.getByText('web-a')).toBeTruthy();
  });

  it('an older server without roles shows every instance as web, with no role filter', async () => {
    renderFleet({ enabled: true, notice: null, now: NOW, apps: [shop], self: null });
    expect(await screen.findByText('web-a')).toBeTruthy();
    expect(screen.getAllByTestId('fleet-role').every((b) => b.textContent === 'web')).toBe(true);
    expect(screen.queryByRole('button', { name: 'All roles' })).toBeNull();
  });

  it('shows why there is no fleet', async () => {
    renderFleet({
      enabled: false,
      notice: 'This telescope keeps no fleet.',
      now: NOW,
      apps: [],
      self: null,
    });
    expect(await screen.findByText('This telescope keeps no fleet.')).toBeTruthy();
  });

  it('says when no instance has sent a heartbeat', async () => {
    renderFleet({ enabled: true, notice: null, now: NOW, apps: [], self: null });
    await waitFor(() =>
      expect(screen.getByText(/No instance has sent a heartbeat yet/)).toBeTruthy(),
    );
  });

  it('keeps an unknown check neutral and never shows 0/0 live', async () => {
    renderFleet({
      enabled: true,
      notice: null,
      now: NOW,
      apps: [
        {
          ...shop,
          deploys: [
            {
              version: 'v3',
              previous: 'v2',
              startedAt: NOW - MIN,
              live: 0,
              total: 0,
              progress: 1,
              complete: true,
            },
          ],
          checks: [{ ...shop.checks[0]!, name: 'stripe', status: 'unknown', exceptions: [] }],
        },
      ],
      self: null,
    });
    expect(await screen.findByText('no live instances')).toBeTruthy();
    expect(screen.queryByText('0/0 live')).toBeNull();
    // What `deriveFleet` emits with nothing live: complete, yet it must not read as a finished rollout.
    expect(screen.queryByText('complete')).toBeNull();
    const incident = screen.getByTestId('fleet-incident');
    expect(incident.className).not.toMatch(/warn/);
    expect(incident.className).not.toMatch(/bad/);
  });

  it('states no heartbeat timing the server may have changed', async () => {
    renderFleet({ enabled: true, notice: null, now: NOW, apps: [shop], self: null });
    expect(await screen.findByText('shop')).toBeTruthy();
    expect(screen.queryByText(/3 intervals/)).toBeNull();
    expect(screen.queryByText(/15 seconds/)).toBeNull();
    expect(screen.queryByText(/`/)).toBeNull();
  });

  it('titles the last seen cell with the full updated and created times', async () => {
    const createdAt = new Date(NOW - 60 * MIN).toISOString();
    const updatedAt = new Date(NOW - 4000).toISOString();
    const full = `Updated ${new Date(updatedAt).toLocaleString()} · Created ${new Date(createdAt).toLocaleString()}`;
    expect(instanceTimes(instance({ createdAt, updatedAt }))).toBe(full);
    // An older server sends only the epoch ms.
    expect(instanceTimes(instance({}))).toBe(full);
    expect(instanceTimes(instance({ createdAt: null, updatedAt: null }))).toBe(
      'Updated — · Created —',
    );
    renderFleet({
      enabled: true,
      notice: null,
      now: NOW,
      apps: [{ ...shop, instances: [instance({ createdAt, updatedAt })] }],
      self: null,
    });
    expect((await screen.findByTestId('fleet-last-seen')).getAttribute('title')).toBe(full);
  });

  it('has its own route', () => {
    expect(parseHash('#/fleet')).toEqual({ name: 'fleet' });
    expect(formatHash({ name: 'fleet' })).toBe('#/fleet');
  });

  it('formats durations', () => {
    expect(humanDuration(40_000)).toBe('40 s');
    expect(humanDuration(400)).toBe('<1 s');
    expect(humanDuration(12 * MIN)).toBe('12 min');
    expect(humanDuration(26 * 60 * MIN)).toBe('1d 2h');
  });
});
