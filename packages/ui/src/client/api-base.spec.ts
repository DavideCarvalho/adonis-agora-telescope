import { describe, expect, it } from 'vitest';
import { deriveApiBase, resolveApiBase, stripTrailingSlash } from './api-base.js';

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
  it('prefers the injected global', () => {
    const win = {
      __TELESCOPE_DASHBOARD_BASE__: '/custom/api/',
      location: { pathname: '/telescope/' },
    } as unknown as Window;
    expect(resolveApiBase(win)).toBe('/custom/api');
  });
  it('falls back to the location-derived base', () => {
    const win = { location: { pathname: '/telescope/' } } as unknown as Window;
    expect(resolveApiBase(win)).toBe('/telescope/api');
  });
});
