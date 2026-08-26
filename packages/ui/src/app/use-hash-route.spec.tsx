import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatHash, parseHash, useHashRoute } from './use-hash-route.js';

function Probe() {
  const { route, navigate } = useHashRoute();
  return (
    <div>
      <span data-testid="route">{JSON.stringify(route)}</span>
      <button type="button" onClick={() => navigate({ name: 'entries', type: 'query' })}>
        go
      </button>
    </div>
  );
}

describe('parseHash', () => {
  it('defaults to overview on empty/unknown hash', () => {
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/bogus')).toEqual(DEFAULT_ROUTE);
  });
  it('parses section routes', () => {
    expect(parseHash('#/overview')).toEqual({ name: 'overview' });
    expect(parseHash('#/traces')).toEqual({ name: 'traces' });
  });
  it('parses entries type query', () => {
    expect(parseHash('#/entries?type=query')).toEqual({ name: 'entries', type: 'query' });
  });
  it('parses deep links', () => {
    expect(parseHash('#/entries/e-1')).toEqual({ name: 'entry', id: 'e-1' });
    expect(parseHash('#/traces/t-1')).toEqual({ name: 'trace', traceId: 't-1' });
    expect(parseHash('#/extensions/durable.workflows')).toEqual({
      name: 'extensions',
      dashboardId: 'durable.workflows',
    });
  });
});

describe('formatHash', () => {
  it('round-trips routes', () => {
    expect(formatHash({ name: 'entry', id: 'e-1' })).toBe('#/entries/e-1');
    expect(formatHash({ name: 'entries', type: 'query' })).toBe('#/entries?type=query');
    expect(formatHash({ name: 'trace', traceId: 't-1' })).toBe('#/traces/t-1');
    expect(formatHash({ name: 'extensions', dashboardId: 'durable.workflows' })).toBe(
      '#/extensions/durable.workflows',
    );
  });
});

describe('useHashRoute', () => {
  it('reads the initial route from the hash, reacts to hashchange, and writes via navigate', () => {
    window.location.hash = '#/pulse';
    render(<Probe />);
    expect(screen.getByTestId('route').textContent).toBe(JSON.stringify({ name: 'pulse' }));

    act(() => {
      window.location.hash = '#/traces/t-9';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('route').textContent).toBe(
      JSON.stringify({ name: 'trace', traceId: 't-9' }),
    );

    fireEvent.click(screen.getByText('go'));
    expect(window.location.hash).toBe('#/entries?type=query');
  });
});
