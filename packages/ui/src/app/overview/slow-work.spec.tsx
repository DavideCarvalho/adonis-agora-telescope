import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../../client/telescope-client.js';
import type { PulseSlowWork, PulseSummary } from '../../client/types.js';
import { TelescopeQueryProvider } from '../query-provider.js';
import { TelescopeClientContext } from '../use-telescope.js';
import { SlowestJobsPanel, slowWorkView } from './containers.js';

const step: PulseSlowWork = {
  source: 'durable',
  name: 'index-thesis',
  count: 12,
  failures: 2,
  p50: 800,
  p95: 4200,
  max: 9100,
};

const off = { durable: false, queue: false };

describe('slowWorkView', () => {
  it('rows win whatever the flags say', () => {
    expect(slowWorkView({ slowJobs: [], slowWork: [step] }, off)).toEqual({
      kind: 'rows',
      rows: [step],
    });
  });

  it('an older server (no slowWork) still lists its queue hotspots', () => {
    const view = slowWorkView(
      { slowJobs: [{ route: 'default:SendEmail', count: 3, p99: 700, p50: 100 }] },
      off,
    );
    expect(view).toEqual({
      kind: 'rows',
      rows: [
        {
          source: 'queue',
          name: 'default:SendEmail',
          count: 3,
          failures: 0,
          p50: 100,
          p95: 700,
          max: 700,
        },
      ],
    });
  });

  it('"not measured" only when neither durable nor the queue watcher is on', () => {
    expect(slowWorkView({ slowJobs: [], slowWork: [] }, off)).toEqual({ kind: 'off' });
  });

  it('durable on and nothing slow: says durable is reporting', () => {
    const view = slowWorkView({ slowJobs: [], slowWork: [] }, { durable: true, queue: false });
    expect(view).toEqual({
      kind: 'quiet',
      message: 'Durable is reporting. No workflow step finished in this window.',
    });
  });

  it('queue on, durable off: the queue empty state', () => {
    const view = slowWorkView({ slowJobs: [], slowWork: [] }, { durable: false, queue: true });
    expect(view).toEqual({ kind: 'quiet', message: 'No jobs in window.' });
  });

  it('both on: one quiet line for both', () => {
    const view = slowWorkView({ slowJobs: [], slowWork: [] }, { durable: true, queue: true });
    expect(view.kind).toBe('quiet');
  });

  it('unknown (null) never claims a source is off', () => {
    const view = slowWorkView({ slowJobs: [], slowWork: [] }, { durable: null, queue: null });
    expect(view).toEqual({ kind: 'quiet', message: 'No jobs or workflow steps in this window.' });
  });
});

function renderPanel(slowWork: PulseSlowWork[], watchers: string[] | null): void {
  const pulse = { slowJobs: [], slowWork } as unknown as PulseSummary;
  const client = {
    pulse: vi.fn().mockResolvedValue(pulse),
    meta: vi.fn().mockResolvedValue({
      entryTypes: [],
      dashboards: [],
      ai: { enabled: false },
      watchers,
    }),
  } as unknown as TelescopeClient;
  render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client}>
        <SlowestJobsPanel windowMs={3_600_000} />
      </TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
}

describe('SlowestJobsPanel', () => {
  it('lists durable steps with p95, max, count and failures', async () => {
    renderPanel([step], ['request', 'durable']);
    await waitFor(() => expect(screen.getByText('index-thesis')).toBeTruthy());
    expect(screen.getByText('step')).toBeTruthy();
    expect(screen.getByText(/p95 · .* max · ×12 · 2 failed/)).toBeTruthy();
    expect(screen.queryByText(/Not measured/)).toBeNull();
  });

  it('durable enabled, quiet window: no "watcher not enabled" advice', async () => {
    renderPanel([], ['request', 'durable']);
    await waitFor(() =>
      expect(
        screen.getByText('Durable is reporting. No workflow step finished in this window.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/Not measured/)).toBeNull();
  });

  it('neither source: names both ways to turn it on', async () => {
    renderPanel([], ['request']);
    await waitFor(() => expect(screen.getByText(/Not measured/)).toBeTruthy());
    expect(screen.getByText('durableTelescopeExtension()')).toBeTruthy();
    expect(screen.getByText("'queue'")).toBeTruthy();
  });
});
