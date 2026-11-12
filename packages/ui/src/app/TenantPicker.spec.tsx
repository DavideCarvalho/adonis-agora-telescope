import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectedTenant, TelescopeClient } from '../client/telescope-client.js';
import type { TenantScope } from '../client/types.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TenantEmptyNotice, TenantPicker, tenantLabel, urlForTenant } from './TenantPicker.js';
import { TelescopeClientContext } from './use-telescope.js';

function renderWith(scope: TenantScope, ui: React.ReactNode) {
  const client = { tenants: vi.fn().mockResolvedValue(scope) } as unknown as TelescopeClient;
  return render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client}>{ui}</TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('tenant selection in the URL', () => {
  it('reads ?tenant= and builds URLs that keep the hash route', () => {
    expect(selectedTenant('?tenant=acme')).toBe('acme');
    expect(selectedTenant('?x=1')).toBeUndefined();
    expect(urlForTenant('acme', 'https://app.test/telescope?x=1#/entries')).toBe(
      '/telescope?x=1&tenant=acme#/entries',
    );
    expect(urlForTenant(undefined, 'https://app.test/telescope?tenant=acme#/traces')).toBe(
      '/telescope#/traces',
    );
  });

  it('the client sends the selected organization on every call', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new TelescopeClient({ baseUrl: '/telescope/api', fetch, tenant: 'acme' });
    await client.listEntries({ type: 'request' });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('tenant=acme');
    expect(client.streamUrl()).toBe('/telescope/api/stream?tenant=acme');
    expect(new TelescopeClient({ baseUrl: '/t/api', fetch }).streamUrl()).toBe(
      '/t/api/stream',
    );
  });
});

describe('TenantPicker', () => {
  it('renders nothing with tenancy off', async () => {
    const { container } = renderWith({ enabled: false, all: true, tenants: [] }, <TenantPicker />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('a single organization is a fixed chip', async () => {
    renderWith(
      { enabled: true, all: false, tenants: [{ id: 'acme', label: 'Acme' }] },
      <TenantPicker />,
    );
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('several or all: a searchable picker with "All organizations" first', async () => {
    renderWith(
      {
        enabled: true,
        all: true,
        tenants: [
          { id: 'acme', label: 'Acme' },
          { id: 'globex', label: 'Globex' },
        ],
      },
      <TenantPicker />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Organization/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toBe('All organizations');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'glo' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Globexglobex']);
  });

  it('asks to choose an organization when the viewer has none', async () => {
    renderWith({ enabled: true, all: false, tenants: [] }, <TenantEmptyNotice />);
    expect(await screen.findByText('Choose an organization to see its data.')).toBeTruthy();
  });

  it('labels fall back to the id', () => {
    expect(tenantLabel(null, 'x')).toBe('x');
    expect(tenantLabel({ enabled: true, all: true, tenants: [{ id: 'a', label: 'A' }] }, 'a')).toBe(
      'A',
    );
  });
});
