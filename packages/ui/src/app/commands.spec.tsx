// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleSearch,
  filterCommands,
  type SearchCommand,
  useSearchShortcut,
} from '../agora-kit/shell/console-search';
import type { DashboardSpec } from '../client/types.js';
import { buildCommands, type CommandTarget } from './commands.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const dashboards: DashboardSpec[] = [{ id: 'durable.workflows', label: 'Workflows', panels: [] }];

function asSearchCommands(onNavigate: (target: CommandTarget) => void): SearchCommand[] {
  return buildCommands(dashboards).map((c) => ({
    id: c.id,
    label: c.label,
    group: c.group,
    hint: c.hint,
    onSelect: () => onNavigate(c.target),
  }));
}

function Harness({ commands, endpoint }: { commands: SearchCommand[]; endpoint?: string }) {
  const [open, setOpen] = useState(false);
  useSearchShortcut(true, setOpen);
  return (
    <ConsoleSearch
      config={endpoint ? { endpoint } : undefined}
      commands={commands}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

describe('buildCommands', () => {
  it('lists every page, every entry type and every contributed dashboard', () => {
    const commands = buildCommands(dashboards);
    expect(commands.find((c) => c.id === 'pulse')?.target).toEqual({
      kind: 'section',
      key: 'pulse',
    });
    expect(commands.find((c) => c.id === 'type:query')).toMatchObject({
      label: 'Entries: query',
      group: 'Entry types',
      target: { kind: 'entryType', type: 'query' },
    });
    expect(commands.find((c) => c.id === 'dashboard:durable.workflows')).toMatchObject({
      label: 'Workflows',
      group: 'Dashboards',
      target: { kind: 'dashboard', id: 'durable.workflows' },
    });
  });

  it('is matched case-insensitively on the label', () => {
    const commands = asSearchCommands(() => {});
    expect(filterCommands(commands, '')).toHaveLength(commands.length);
    expect(filterCommands(commands, 'QUERY').map((c) => c.id)).toEqual(['type:query']);
    expect(filterCommands(commands, 'nonexistent')).toEqual([]);
  });
});

describe('⌘K with Telescope commands', () => {
  it('opens on ⌘K without a search endpoint, filters the jumps and runs one on Enter', async () => {
    const onNavigate = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    render(<Harness commands={asSearchCommands(onNavigate)} />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const input = await screen.findByRole('combobox', { name: 'Search' });
    // Before typing, every jump is listed.
    expect(screen.getByText('Overview')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'pulse' } });
    await waitFor(() => expect(screen.queryByText('Overview')).toBeNull());
    expect(screen.getByText('Pulse')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'section', key: 'pulse' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists the local jumps above the cross-console hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              groups: [
                {
                  id: 'durable',
                  title: 'Workflows',
                  icon: 'workflow',
                  hits: [{ title: 'run-query-1', href: '/durable#/run/run-query-1' }],
                },
              ],
            }),
          ),
        ),
      ),
    );
    render(
      <Harness commands={asSearchCommands(() => {})} endpoint="/telescope/api/consoles/search" />,
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'query' },
    });
    await waitFor(() => expect(screen.getByText('run-query-1')).toBeTruthy(), { timeout: 2000 });
    const local = screen.getByText('Entries: query');
    const remote = screen.getByText('run-query-1');
    expect(local.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
