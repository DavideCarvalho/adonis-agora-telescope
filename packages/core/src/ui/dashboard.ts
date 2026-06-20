import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The raw dashboard HTML, read once from the sibling `dashboard.html` (copied into
 * `dist/src/` by the build's `copy:assets` step). Lazily loaded + cached so the
 * file read happens at most once per process and only when the dashboard is served.
 */
let cachedHtml: string | null = null;

function loadHtml(): string {
  if (cachedHtml === null) {
    const htmlPath = fileURLToPath(new URL('./dashboard.html', import.meta.url));
    cachedHtml = readFileSync(htmlPath, 'utf8');
  }
  return cachedHtml;
}

/**
 * Render the self-contained dashboard page, injecting the JSON API base path so
 * the inline script knows where to fetch from. The template contains a
 * `__TELESCOPE_API_BASE__` placeholder which is replaced with `apiBase` (e.g.
 * `/telescope/api`).
 */
export function renderDashboard(apiBase: string): string {
  return loadHtml().replaceAll('__TELESCOPE_API_BASE__', escapeForScript(apiBase));
}

/** Escape characters that would break out of the single-quoted JS string literal. */
function escapeForScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
}
