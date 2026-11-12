import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../client/telescope-client.js';
import type { ColumnAction } from '../client/types.js';
import {
  actionApplies,
  actionInput,
  ColumnActionButton,
  fillText,
  resolveColumnAction,
} from './ColumnActionButton.js';
import { TelescopeQueryProvider } from './query-provider.js';
import { TelescopeClientContext } from './use-telescope.js';

const reset: ColumnAction = {
  name: 'resilience.reset-circuit',
  label: 'Reset',
  confirm: 'Reset circuit {key}?',
  input: { key: '{key}' },
  showWhen: { status: ['open', 'half-open'] },
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

  it('falls back to the action-level label, confirm and style', () => {
    const bare: ColumnAction = { name: 'resilience.reset-circuit', input: { key: '{key}' } };
    expect(
      resolveColumnAction(bare, {
        name: 'resilience.reset-circuit',
        label: 'Reset',
        confirm: 'Reset {key}?',
        destructive: true,
      }),
    ).toMatchObject({ label: 'Reset', confirm: 'Reset {key}?', destructive: true });
    expect(resolveColumnAction(bare, undefined)).toMatchObject({
      label: 'resilience.reset-circuit',
      confirm: 'resilience.reset-circuit?',
      destructive: false,
    });
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

  it('a network failure is shown and the dialog can still be closed', async () => {
    const extAction = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { onDone } = renderButton({ extAction }, { key: 'stripe', status: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('renders no button on a row the action does not apply to', () => {
    renderButton({ extAction: vi.fn() }, { key: 'stripe', status: 'closed' });
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});
