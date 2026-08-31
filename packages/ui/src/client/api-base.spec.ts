import { describe, expect, it } from 'vitest';
import {
  CONFIG_ELEMENT_ID,
  deriveApiBase,
  resolveApiBase,
  stripTrailingSlash,
} from './api-base.js';

describe('stripTrailingSlash', () => {
  it('strips trailing slashes but keeps root', () => {
    expect(stripTrailingSlash('/telescope/')).toBe('/telescope');
    expect(stripTrailingSlash('/telescope//')).toBe('/telescope');
    expect(stripTrailingSlash('/')).toBe('/');
  });
});

describe('deriveApiBase', () => {
  it('appends /api to the mount pathname', () => {
    expect(deriveApiBase('/telescope/')).toBe('/telescope/api');
    expect(deriveApiBase('/telescope')).toBe('/telescope/api');
    expect(deriveApiBase('/admin/scope/')).toBe('/admin/scope/api');
  });
  it('is idempotent when already ending in /api', () => {
    expect(deriveApiBase('/telescope/api')).toBe('/telescope/api');
  });
  it('handles root', () => {
    expect(deriveApiBase('/')).toBe('/api');
  });
});

describe('resolveApiBase', () => {
  /** A document carrying the provider's data block, as `injectApiBase` emits it. */
  const docWith = (text: string) =>
    ({
      getElementById: (id: string) => (id === CONFIG_ELEMENT_ID ? { textContent: text } : null),
    }) as unknown as Document;
  const noDoc = { getElementById: () => null } as unknown as Document;

  it('prefers the JSON data block the provider injects', () => {
    const win = {
      __TELESCOPE_DASHBOARD_BASE__: '/stale/api',
      location: { pathname: '/telescope/' },
    } as unknown as Window;
    expect(resolveApiBase(win, docWith('{"apiBase":"/custom/api/"}'))).toBe('/custom/api');
  });
  it('ignores a block that is not JSON, or carries no base', () => {
    const win = { location: { pathname: '/telescope/' } } as unknown as Window;
    expect(resolveApiBase(win, docWith('{nope'))).toBe('/telescope/api');
    expect(resolveApiBase(win, docWith('{"apiBase":""}'))).toBe('/telescope/api');
  });
  it('prefers the injected global over the location when there is no block', () => {
    const win = {
      __TELESCOPE_DASHBOARD_BASE__: '/custom/api/',
      location: { pathname: '/telescope/' },
    } as unknown as Window;
    expect(resolveApiBase(win, noDoc)).toBe('/custom/api');
  });
  it('falls back to the location-derived base', () => {
    const win = { location: { pathname: '/telescope/' } } as unknown as Window;
    expect(resolveApiBase(win, noDoc)).toBe('/telescope/api');
  });
});
