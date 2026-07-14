/**
 * Pure path/asset helpers for the dashboard provider — extracted so they can be unit-tested without
 * booting an AdonisJS app. The provider composes these; it holds only the router wiring + I/O.
 */

/** Collapse duplicate slashes and strip leading/trailing ones: `/telescope//` → `telescope`. */
export function trimSlashes(path: string): string {
  return path.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * The dashboard mount path as an absolute path with a single leading slash and no trailing slash:
 * `telescope` → `/telescope`, `/telescope/` → `/telescope`. An empty path collapses to `/`.
 */
export function mountPathFor(path: string): string {
  const trimmed = trimSlashes(path);
  return trimmed === '' ? '/' : `/${trimmed}`;
}

/**
 * The JSON API base the SPA calls, derived from the mount path: `<mount>/api`. This MUST match the
 * base the core `telescope_ui` provider registers its `/entries`, `/metrics/*`, `/stream`, … routes
 * under (`${config.path}/api`), so the SPA hits the real endpoints.
 */
export function apiBaseFor(path: string): string {
  const mount = mountPathFor(path);
  return mount === '/' ? '/api' : `${mount}/api`;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** MIME type for a filename by extension; `application/octet-stream` for anything unknown. */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Reject a wildcard asset request that tries to escape the SPA root via `..`, a backslash, a NUL,
 * or an absolute path. Returns the safe, normalized relative segments (never starting with `..`),
 * or `null` to deny.
 */
export function safeAssetSegments(wildcard: string | string[] | undefined): string[] | null {
  const parts = Array.isArray(wildcard) ? wildcard : (wildcard ?? '').split('/');
  const segments: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes('\0') || part.includes('\\')) return null;
    segments.push(part);
  }
  return segments;
}

/**
 * Inject the resolved JSON API base into the served `index.html` as a global the SPA reads before
 * boot, so the client calls the exact base the provider mounted (no build-time coupling). Idempotent
 * per response — inserted right before `</head>`.
 */
export function injectApiBase(html: string, apiBase: string): string {
  const tag = `<script>window.__TELESCOPE_DASHBOARD_BASE__=${JSON.stringify(apiBase)}</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
}

/**
 * Rewrite the SPA shell's root-relative `./` asset references to be absolute under the dashboard
 * mount: `src="./assets/x.js"` → `src="/telescope/assets/x.js"`.
 *
 * The SPA is a Vite `base: './'` build, so its asset URLs are relative to the request path. Serving
 * it under a prefix normally relies on a trailing slash (`<mount>/`) so `./assets/*` resolves to
 * `<mount>/assets/*`. But the AdonisJS router normalizes trailing slashes — `<mount>` and `<mount>/`
 * are the same route — so the dashboard provider serves the shell at the bare `<mount>` and rewrites
 * the relative refs here instead. The result is identical to what a `<mount>/` request would resolve
 * to, but works no matter which form the browser requested. A root mount (`/`) needs no rewrite.
 */
export function rewriteRelativeAssets(html: string, mount: string): string {
  if (mount === '/') return html;
  return html.replace(/(["'])\.\//g, `$1${mount}/`);
}
