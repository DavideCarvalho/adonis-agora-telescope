import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { DashboardSpec } from '../client/types.js';
import { ExtensionsSection } from './ExtensionsSection.js';
import { TelescopeClientContext } from './use-telescope.js';

const dashboards: DashboardSpec[] = [
  {
    id: 'd1',
    label: 'Dashboard One',
    panels: [{ kind: 'stat', title: 'One stat', data: { provider: 'one.count' } }],
  },
  {
    id: 'd2',
    label: 'Dashboard Two',
    panels: [{ kind: 'stat', title: 'Two stat', data: { provider: 'two.count' } }],
  },
];

function fakeClient(overrides: Partial<TelescopeClient> = {}): TelescopeClient {
  return {
    meta: vi.fn().mockResolvedValue({ entryTypes: [], dashboards, ai: { enabled: false } }),
    extData: vi.fn().mockResolvedValue({ value: 42 }),
    ...overrides,
  } as unknown as TelescopeClient;
}

function renderWith(client: TelescopeClient, ui: ReactNode) {
  return render(
    <StrictMode>
      <TelescopeClientContext.Provider value={client}>{ui}</TelescopeClientContext.Provider>
    </StrictMode>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('ExtensionsSection', () => {
  it('renders the first dashboard without auto-navigating when no dashboard is selected', async () => {
    const onSelect = vi.fn();
    renderWith(
      fakeClient(),
      <ExtensionsSection selectedId={null} onSelect={onSelect} onOpenTrace={vi.fn()} />,
    );

    // The body defaults to the first dashboard — its panel must render.
    await waitFor(() => expect(screen.getByText('One stat')).toBeTruthy());
    // `selectedId === null` is a render default, not a navigation action — with hash routing an
    // auto-select would push a history entry and trap browser Back on bare `#/extensions`.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onSelect when a different dashboard tab is clicked', async () => {
    const onSelect = vi.fn();
    renderWith(
      fakeClient(),
      <ExtensionsSection selectedId={null} onSelect={onSelect} onOpenTrace={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByText('One stat')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Dashboard Two' }));
    expect(onSelect).toHaveBeenCalledWith('d2');
  });
});
