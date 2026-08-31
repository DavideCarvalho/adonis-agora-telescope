import { readFile } from 'node:fs/promises';
import {
  type AuthorizeHook,
  enforceDashboardAuth,
  enforceGuard,
  type ResolvedDashboardAuth,
  resolveConfig as resolveUiConfig,
  type TelescopeUiConfig,
  type UiHttpContext,
} from '@adonis-agora/telescope/ui';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  resolveDashboardConfig,
  type TelescopeDashboardConfig,
} from '../src/server/define_config.js';
import {
  apiBaseFor,
  contentTypeFor,
  injectApiBase,
  mountPathFor,
  rewriteRelativeAssets,
  safeAssetSegments,
} from '../src/server/paths.js';

/**
 * Serves the `@adonis-agora/telescope-ui` observability SPA (a Vite build in `dist/spa`) as static
 * assets under the SAME prefix the core `telescope_ui` provider mounts its JSON API + SSE stream
 * (`config('telescope_ui').path`, default `/telescope`), behind the SAME `authorize` guard via the
 * core {@link enforceGuard}. This is a thin, idiomatic AdonisJS static server — no NestJS module, no
 * bundled API. The SPA calls the telescope core's own real read routes (`<path>/api/*`) and the SSE
 * live stream (`<path>/api/stream`).
 *
 * This provider owns the prefix root: the SPA serves `<path>` and `<path>/*`, while the core
 * provider keeps `<path>/api/*`. The core ships no page of its own, so without this package
 * `<path>` is a 404. Static route segments take precedence over the SPA's `<path>/*`
 * wildcard in the AdonisJS router, so the API routes always win.
 *
 * Routes (mount = `config('telescope_ui').path`, default `/telescope`):
 * - `GET <mount>`   → the SPA shell (`index.html`, with the resolved API base injected)
 * - `GET <mount>/*` → a built asset, or the SPA shell as a fallback (client-rendered console)
 *
 * There is deliberately no separate `<mount>/` route and no redirect between the two forms — see
 * {@link boot}'s note on why registering both would collide.
 *
 * Enable/disable and override the mount via the optional `config('telescope_ui').dashboard` block.
 */
export default class TelescopeUiDashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** The built SPA directory (`dist/spa`) as a `file://` URL, next to this compiled provider. */
  private spaDirUrl = new URL('../spa/', import.meta.url);

  async boot() {
    const uiConfig = resolveUiConfig(
      this.app.config.get<TelescopeUiConfig | undefined>('telescope_ui', undefined),
    );
    // If the core UI (JSON API) is off, there is no backend for the SPA to talk to — serve nothing.
    if (!uiConfig.enabled) return;

    const dashboardConfig = resolveDashboardConfig(
      this.app.config.get<TelescopeDashboardConfig>('telescope_ui.dashboard', {}),
    );
    if (!dashboardConfig.enabled) return;

    const path = dashboardConfig.path ?? uiConfig.path;
    const mount = mountPathFor(path);
    const apiBase = apiBaseFor(path);
    const guard = uiConfig.authorize;
    const auth = uiConfig.dashboardAuth;
    // The built-in login page is registered by the core `telescope_ui` provider under the resolved
    // `telescope_ui.path`; a page navigation with no valid session redirects there.
    const loginBase = uiConfig.path;

    // Resolve the router from the container — NOT the `@adonisjs/core/services/router` façade,
    // whose default export is populated only inside `app.booted()` (which runs AFTER every
    // provider's boot()), so at boot() it is still `undefined` and crashes on `.get`.
    const router = await this.app.container.make('router');

    // The SPA shell, served at the bare mount. We do NOT register a separate `<mount>/` route and
    // redirect `<mount>` to it (the trailing-slash trick a `base: './'` build usually needs): the
    // AdonisJS router normalizes trailing slashes, so `<mount>` and `<mount>/` are the SAME pattern
    // and registering both throws "Duplicate route". Instead {@link sendIndex} rewrites the shell's
    // relative `./assets/*` URLs to absolute `<mount>/assets/*`, so they resolve regardless of the
    // trailing slash — no redirect, no collision.
    router.get(mount, async (ctx) => {
      if (!(await this.gate(ctx, guard, auth, loginBase))) return;
      await this.sendIndex(ctx, mount, apiBase);
    });

    // Built assets (JS/CSS/fonts/...), with an index fallback for any unmatched path so the
    // client-rendered console still boots on a deep link. The static `<mount>/api/*` routes the core
    // provider registers take precedence over this wildcard in the router.
    router.get(`${mount}/*`, async (ctx) => {
      if (!(await this.gate(ctx, guard, auth, loginBase))) return;
      const segments = safeAssetSegments(ctx.params['*']);
      if (segments === null) {
        return ctx.response.status(400).json({ error: 'bad asset path' });
      }
      await this.sendAsset(ctx, segments, mount, apiBase);
    });
  }

  /**
   * Run the composed dashboard guard, mirroring the JSON API routes: the `authorize` hook FIRST,
   * then — only when `dashboardAuth` is configured — the signed-session guard in `page` mode (a
   * page navigation with no valid session is redirected `302` to the login page). Returns `true` to
   * proceed; on denial the guard has already written the response and this returns `false`. When
   * `dashboardAuth` is omitted (`auth === null`) this is exactly the `authorize` guard, unchanged.
   */
  private async gate(
    ctx: HttpContext,
    guard: AuthorizeHook,
    auth: ResolvedDashboardAuth | null,
    loginBase: string,
  ): Promise<boolean> {
    if (!(await enforceGuard(ctx as unknown as UiHttpContext, guard))) return false;
    if (auth === null) return true;
    return enforceDashboardAuth(ctx, auth, 'page', loginBase);
  }

  /**
   * Read `dist/spa/index.html`, rewrite its relative `./assets/*` URLs to absolute `<mount>/...`
   * (the SPA is a `base: './'` Vite build; see {@link rewriteRelativeAssets}), inject the API base,
   * and send it.
   */
  private async sendIndex(ctx: HttpContext, mount: string, apiBase: string): Promise<void> {
    const html = await readFile(new URL('index.html', this.spaDirUrl), 'utf8');
    ctx.response.header('content-type', 'text/html; charset=utf-8');
    ctx.response.header('cache-control', 'no-store, must-revalidate');
    ctx.response.send(injectApiBase(rewriteRelativeAssets(html, mount), apiBase));
  }

  /** Send the requested built asset, or fall back to the SPA shell when it does not exist. */
  private async sendAsset(
    ctx: HttpContext,
    segments: string[],
    mount: string,
    apiBase: string,
  ): Promise<void> {
    const filename = segments[segments.length - 1] ?? 'index.html';
    try {
      const buffer = await readFile(new URL(segments.join('/'), this.spaDirUrl));
      ctx.response.header('content-type', contentTypeFor(filename));
      ctx.response.send(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.sendIndex(ctx, mount, apiBase);
        return;
      }
      throw error;
    }
  }
}
