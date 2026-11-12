import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  iconKey,
  isSafeHref,
  moveIndex,
  parseConsoles,
  parseSearchGroups,
  readShellSwitcherConfig,
} from '../client/console_switcher.js';
import { CommandPalette } from './CommandPalette.js';
import { ConsoleSwitcher } from './ConsoleSwitcher.js';
import { TelescopeQueryProvider } from './query-provider.js';

function mockFetch(body: unknown) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const brand = <span>Telescope</span>;

describe('switcher data', () => {
  it('keeps only same-origin hrefs, maps unknown icons, wraps arrows', () => {
    expect(isSafeHref('/durable')).toBe(true);
    for (const bad of ['//evil', 'https://x', 'javascript:alert(1)', '/a\\b', '']) {
      expect(isSafeHref(bad)).toBe(false);
    }
    expect(iconKey('rocket')).toBe('generic');
    expect(
      parseConsoles({
        consoles: [
          { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
          { id: 'evil', title: 'Evil', icon: 'x', href: '//evil' },
        ],
      }),
    ).toEqual([{ id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' }]);
    expect(
      parseSearchGroups({
        groups: [
          { id: 'a', title: 'A', icon: 'media', hits: [{ title: 'x', href: 'https://x' }] },
          { id: 'b', title: 'B', icon: 'media', hits: [{ title: 'y', href: '/b/y' }] },
        ],
      }),
    ).toEqual([{ id: 'b', title: 'B', icon: 'media', hits: [{ title: 'y', href: '/b/y' }] }]);
    expect(moveIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(moveIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(moveIndex(1, 'End', 3)).toBe(2);
  });

  it('reads switcher/search from the data block only when others > 0', () => {
    const block = (json: unknown) => {
      const doc = document.implementation.createHTMLDocument('shell');
      doc.body.innerHTML = `<script type="application/json" id="telescope-dashboard-config">${JSON.stringify(json)}</script>`;
      return readShellSwitcherConfig(doc);
    };
    expect(block({ apiBase: '/t/api' })).toEqual({});
    expect(block({ switcher: { endpoint: '/t/api/consoles', others: 0 } })).toEqual({});
    expect(
      block({
        switcher: { endpoint: '/t/api/consoles', others: 2 },
        search: { endpoint: '/t/api/consoles/search' },
      }),
    ).toEqual({
      switcher: { endpoint: '/t/api/consoles', others: 2 },
      search: { endpoint: '/t/api/consoles/search' },
    });
  });
});

describe('ConsoleSwitcher', () => {
  it('is the plain brand with no endpoint, and makes no request', () => {
    const fetch = mockFetch({ consoles: [] });
    render(
      <TelescopeQueryProvider>
        <ConsoleSwitcher brand={brand} />
      </TelescopeQueryProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stays the plain brand when the list is empty', async () => {
    const fetch = mockFetch({ version: 1, current: 'telescope', consoles: [] });
    render(
      <TelescopeQueryProvider>
        <ConsoleSwitcher brand={brand} endpoint="/telescope/api/consoles" />
      </TelescopeQueryProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a menu: current console first (not a link), others as links; Esc restores focus', async () => {
    mockFetch({
      version: 1,
      current: 'telescope',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'payments', title: 'Payments', icon: 'payments', href: '/payments' },
      ],
    });
    render(
      <TelescopeQueryProvider>
        <ConsoleSwitcher brand={brand} endpoint="/telescope/api/consoles" />
      </TelescopeQueryProvider>,
    );
    const button = await screen.findByRole('button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((a) => a.getAttribute('href'))).toEqual(['/durable', '/payments']);
    expect(screen.getByLabelText('Current console')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('CommandPalette global search', () => {
  it('adds hits from every console the viewer may open', async () => {
    const fetch = mockFetch({
      version: 1,
      query: 'run',
      groups: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [{ title: 'run-42', href: '/durable/runs/42' }],
        },
      ],
    });
    render(
      <TelescopeQueryProvider>
        <CommandPalette
          dashboards={[]}
          onNavigate={vi.fn()}
          searchEndpoint="/telescope/api/consoles/search"
        />
      </TelescopeQueryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open command palette' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'run' } });
    expect(await screen.findByText('run-42', {}, { timeout: 2000 })).toBeTruthy();
    expect(String(fetch.mock.calls[0]?.[0])).toBe('/telescope/api/consoles/search?q=run');
  });

  it('never searches without an endpoint', async () => {
    const fetch = mockFetch({ groups: [] });
    render(
      <TelescopeQueryProvider>
        <CommandPalette dashboards={[]} onNavigate={vi.fn()} />
      </TelescopeQueryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open command palette' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'run' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetch).not.toHaveBeenCalled();
  });
});
