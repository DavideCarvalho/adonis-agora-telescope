import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { ColumnAction } from '../client/types.js';
import { actionApplies, actionInput, ColumnActionButton, fillText } from './ColumnActionButton.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

const reset: ColumnAction = {
  action: 'resilience.reset-circuit',
  label: 'Reset',
  confirm: 'Reset circuit {key}?',
  input: { key: '{key}' },
  when: { key: 'status', in: ['open', 'half-open'] },
  destructive: true,
};

function renderButton(client: Partial<TelescopeClient>, row: Record<string, unknown>) {
  const onDone = vi.fn();
  render(
    <TelescopeQueryProvider>
      <TelescopeClientContext.Provider value={client as TelescopeClient}>
        <ColumnActionButton ext="resilience" action={reset} row={row} onDone={onDone} />
      </TelescopeClientContext.Provider>
    </TelescopeQueryProvider>,
  );
  return { onDone };
}

afterEach(() => vi.clearAllMocks());

describe('column actions', () => {
  it('fills templates and filters rows', () => {
    expect(fillText('Reset {key}?', { key: 'stripe' })).toBe('Reset stripe?');
    expect(actionInput(reset, { key: 'stripe' })).toEqual({ key: 'stripe' });
    expect(actionApplies(reset, { status: 'open' })).toBe(true);
    expect(actionApplies(reset, { status: 'closed' })).toBe(false);
  });

  it('asks for confirmation, runs the action, then reloads', async () => {
    const extAction = vi.fn().mockResolvedValue({ ok: true, data: null });
    const { onDone } = renderButton({ extAction }, { key: 'stripe', status: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('Reset circuit stripe?')).toBeTruthy();
    expect(extAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(extAction).toHaveBeenCalledWith('resilience', 'resilience.reset-circuit', {
      key: 'stripe',
    });
  });

  it('shows the failure in the dialog and does not reload', async () => {
    const extAction = vi.fn().mockResolvedValue({ ok: false, message: 'forbidden' });
    const { onDone } = renderButton({ extAction }, { key: 'stripe', status: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('renders no button on a row the action does not apply to', () => {
    renderButton({ extAction: vi.fn() }, { key: 'stripe', status: 'closed' });
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});
