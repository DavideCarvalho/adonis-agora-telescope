import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectedApp, TelescopeClient } from '../client/telescope-client.js';
import type { AppScope } from '../client/types.js';
import { AppEmptyNotice, AppPicker, appLabel, urlForApp } from './AppPicker.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

function renderWith(scope: AppScope, ui: React.ReactNode) {
  const client = { apps: vi.fn().mockResolvedValue(scope) } as unknown as TelescopeClient;
  return render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client}>{ui}</TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

const two: AppScope = {
  enabled: true,
  all: true,
  apps: [
    { id: 'shop', label: 'Shop' },
    { id: 'billing', label: 'Billing' },
  ],
};

describe('app selection in the URL', () => {
  it('reads ?app= and builds URLs that keep the hash route and the organization', () => {
    expect(selectedApp('?app=shop')).toBe('shop');
    expect(selectedApp('?x=1')).toBeUndefined();
    expect(selectedApp('?app=*')).toBeUndefined();
    expect(urlForApp('shop', 'https://app.test/telescope?tenant=acme#/entries')).toBe(
      '/telescope?tenant=acme&app=shop#/entries',
    );
    expect(urlForApp(undefined, 'https://app.test/telescope?app=shop#/traces')).toBe(
      '/telescope#/traces',
    );
  });

  it('the client sends the selected app (and organization) on every call', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new TelescopeClient({
      baseUrl: '/telescope/api',
      fetch,
      tenant: 'acme',
      app: 'shop',
    });
    await client.listEntries({ type: 'request' });
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain('app=shop');
    expect(url).toContain('tenant=acme');
    expect(client.streamUrl()).toBe('/telescope/api/stream?tenant=acme&app=shop');
    expect(new TelescopeClient({ baseUrl: '/t/api', fetch, app: 'x' }).streamUrl()).toBe(
      '/t/api/stream?app=x',
    );
  });

  it('a server without the apps endpoint means no picker', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const client = new TelescopeClient({ baseUrl: '/t/api', fetch });
    expect(await client.apps()).toEqual({ enabled: false, all: true, apps: [] });
  });
});

describe('AppPicker', () => {
  it('renders nothing when no entry carries an app tag', async () => {
    const { container } = renderWith({ enabled: false, all: true, apps: [] }, <AppPicker />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('a single app is a fixed chip', async () => {
    renderWith({ enabled: true, all: false, apps: [{ id: 'shop', label: 'Shop' }] }, <AppPicker />);
    expect(await screen.findByText('Shop')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('several or all: a searchable picker with "All apps" first', async () => {
    renderWith(two, <AppPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /App/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All apps', 'Shopshop', 'Billingbilling']);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bil' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Billingbilling']);
  });

  it('keyboard: arrows move, Enter picks (reloading with ?app=), Escape closes', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, href: window.location.href, assign });
    renderWith(two, <AppPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /App/ }));
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('app=billing'));
    fireEvent.click(screen.getByRole('button', { name: /App/ }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('says so when the viewer is limited to apps and has none', async () => {
    renderWith({ enabled: true, all: false, apps: [] }, <AppEmptyNotice />);
    expect(await screen.findByText('You have no app to look at here.')).toBeTruthy();
  });

  it('labels fall back to the id', () => {
    expect(appLabel(null, 'x')).toBe('x');
    expect(appLabel(two, 'shop')).toBe('Shop');
  });
});
