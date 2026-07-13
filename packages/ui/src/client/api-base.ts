/**
 * Resolve the base URL of the telescope JSON API the SPA calls. The provider injects the exact base
 * it mounted the API under as `window.__TELESCOPE_DASHBOARD_BASE__` (e.g. `/telescope/api`) when it
 * serves `index.html`; when that is absent (e.g. the standalone `vite dev` preview) we derive it from
 * the page's own location by appending `/api` to the mount pathname. Either way the SPA never
 * hard-codes `/telescope`.
 */

declare global {
  interface Window {
    __TELESCOPE_DASHBOARD_BASE__?: string;
  }
}

/** Strip trailing slashes (but never reduce `/` itself to `''`). */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Derive the API base from the dashboard's own `pathname`. The SPA shell is served at the mount root
 * (e.g. `/telescope/`), and the API lives at `<mount>/api`, so we append `/api` unless the path
 * already ends in it: `/telescope/` → `/telescope/api`, `/telescope/api` → `/telescope/api`.
 */
export function deriveApiBase(pathname: string): string {
  const clean = stripTrailingSlash(pathname);
  const base = clean === '' ? '' : clean;
  if (base.endsWith('/api')) return base;
  return base === '' || base === '/' ? '/api' : `${base}/api`;
}

/** The resolved API base for this page (injected value wins, else location-derived). */
export function resolveApiBase(
  win: Pick<Window, 'location'> & { __TELESCOPE_DASHBOARD_BASE__?: string } = window,
): string {
  const injected = win.__TELESCOPE_DASHBOARD_BASE__;
  if (typeof injected === 'string' && injected !== '') return stripTrailingSlash(injected);
  return deriveApiBase(win.location.pathname);
}
