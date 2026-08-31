/**
 * Resolve the base URL of the telescope JSON API the SPA calls. The provider hands the exact base it
 * mounted the API under to the page as a JSON data block
 * (`<script type="application/json" id="telescope-dashboard-config">{"apiBase":…}</script>`) when
 * it serves `index.html`; a `window.__TELESCOPE_DASHBOARD_BASE__` global is honoured after it
 * (tests, hand-embedding); and when both are absent (e.g. the standalone `vite dev` preview) we
 * derive it from the page's own location by appending `/api` to the mount pathname. Either way the
 * SPA never hard-codes `/telescope`.
 *
 * The data block, and not an inline script setting the global, because a host
 * Content-Security-Policy of `script-src 'self' 'nonce-…'` (shield's `@nonce`) refuses an un-nonced
 * inline script without a word: the global was never set and the location-derived base took over
 * — right for the usual layout, 404 on every request for a custom one, from a console that rendered
 * perfectly. A data block is never executed, so no policy can refuse it.
 */

declare global {
  interface Window {
    __TELESCOPE_DASHBOARD_BASE__?: string;
  }
}

/** `id` of the data block the provider injects (`src/server/paths.ts`'s `CONFIG_ELEMENT_ID`). */
export const CONFIG_ELEMENT_ID = 'telescope-dashboard-config';

/** The `apiBase` carried by the injected data block, or `undefined` when there is none. */
function readInjectedApiBase(
  doc: Pick<Document, 'getElementById'> | undefined,
): string | undefined {
  const element = doc?.getElementById(CONFIG_ELEMENT_ID) ?? null;
  if (element === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    const apiBase = (parsed as { apiBase?: unknown } | null)?.apiBase;
    return typeof apiBase === 'string' && apiBase !== '' ? apiBase : undefined;
  } catch {
    return undefined;
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

/** The resolved API base for this page: the data block, else the global, else location-derived. */
export function resolveApiBase(
  win: Pick<Window, 'location'> & { __TELESCOPE_DASHBOARD_BASE__?: string } = window,
  doc: Pick<Document, 'getElementById'> | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): string {
  const fromBlock = readInjectedApiBase(doc);
  if (fromBlock !== undefined) return stripTrailingSlash(fromBlock);
  const injected = win.__TELESCOPE_DASHBOARD_BASE__;
  if (typeof injected === 'string' && injected !== '') return stripTrailingSlash(injected);
  return deriveApiBase(win.location.pathname);
}
