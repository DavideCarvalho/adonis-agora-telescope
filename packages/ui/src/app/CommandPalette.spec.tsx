import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardSpec } from '../client/types.js';
import { CommandPalette, filterActions } from './CommandPalette.js';

describe('filterActions', () => {
  const actions = [
    {
      id: 'a',
      label: 'Pulse',
      hint: '',
      target: { kind: 'section' as const, key: 'pulse' as const },
    },
    {
      id: 'b',
      label: 'Entries: query',
      hint: '',
      target: { kind: 'entryType' as const, type: 'query' },
    },
  ];

  it('returns every action for an empty query', () => {
    expect(filterActions(actions, '')).toHaveLength(2);
  });

  it('matches case-insensitively on the label substring', () => {
    expect(filterActions(actions, 'QUERY')).toEqual([actions[1]]);
    expect(filterActions(actions, 'pul')).toEqual([actions[0]]);
  });

  it('returns nothing when no label matches', () => {
    expect(filterActions(actions, 'nonexistent')).toEqual([]);
  });
});

describe('CommandPalette', () => {
  it('opens on ⌘K, filters results, and navigates on Enter', () => {
    const onNavigate = vi.fn();
    const dashboards: DashboardSpec[] = [{ id: 'durable.runs', label: 'Runs', panels: [] }];
    render(<CommandPalette dashboards={dashboards} onNavigate={onNavigate} />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByPlaceholderText('Jump to…');
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: 'pulse' } });
    expect(screen.getByText('Pulse')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'section', key: 'pulse' });
  });

  it('closes on Escape without navigating', () => {
    const onNavigate = vi.fn();
    render(<CommandPalette dashboards={[]} onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('Jump to…');
    expect(input).toBeTruthy();
    // Base UI's Dialog dismisses on Escape via a listener scoped to the dialog subtree (matching
    // `@dudousxd/nestjs-telescope-ui`'s `command-palette.spec.tsx`), so — unlike the old hand-rolled
    // overlay's window-level handler — the key event must originate from inside the dialog.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Jump to…')).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
