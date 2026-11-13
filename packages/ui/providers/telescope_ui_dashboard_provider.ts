import { readFile } from 'node:fs/promises';
import { getTelescopeRuntime } from '@adonis-agora/telescope';
import {
  type AuthorizeHook,
  enforceGuard,
  enforcePageGuard,
  type PageGuardOptions,
  resolveConfig as resolveUiConfig,
  runGuard,
  type TelescopeUiConfig,
  type UiHttpContext,
} from '@adonis-agora/telescope/ui';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { type SearchableStore, telescopeConsoleSearch } from '../src/server/console_search.js';
import { resolveSignOut, resolveViewer } from '../src/server/console_shell.js';
import {
  type AgoraConsoleDecision,
  countOtherConsoles,
  listVisibleConsoles,
  readAgoraConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../src/server/console_switcher.js';
import {
  type ResolvedTelescopeDashboardConfig,
  resolveDashboardConfig,
  type TelescopeDashboardConfig,
} from '../src/server/define_config.js';
import {
  apiBaseFor,
  contentTypeFor,
  injectApiBase,
  mountPathFor,
  rewriteRelativeAssets,
  type ShellFields,
  safeAssetSegments,
} from '../src/server/paths.js';

/**
 * Serves the `@adonis-agora/telescope-ui` observability SPA (a Vite build in `dist/spa`) as static
 * assets under the SAME prefix the core `telescope_ui` provider mounts its JSON API + SSE stream
 * (`config('telescope_ui').path`, default `/telescope`), behind the SAME `authorize` guard via the
 * core {@link enforcePageGuard} (the page-flavoured `enforceGuard`: a refused browser gets the
 * access-denied page, not the API's JSON). This is a thin, idiomatic AdonisJS static server — no NestJS module, no
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
/** Telescope's id in the `'agora.consoles'` registry. */
const CONSOLE_ID = 'telescope';

export default class TelescopeUiDashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** The built SPA directory (`dist/spa`) as a `file://` URL, next to this compiled provider. */
  private spaDirUrl = new URL('../spa/', import.meta.url);

  async boot() {
    const uiConfig = resolveUiConfig(
      this.app.config.get<TelescopeUiConfig | undefined>('telescope_ui', undefined),
      { inProduction: this.app.inProduction === true },
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
    // What a refused browser sees (the core guard's JSON is for the API). `basePath` is where THIS
    // SPA lives, which may differ from `telescope_ui.path` when `dashboard.path` overrides the mount.
    const denial: PageGuardOptions = { basePath: path, accessDenied: uiConfig.accessDenied };

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
    // The console switcher: telescope joins the shared `'agora.consoles'` registry, and the shell's
    // brand lists the other consoles this viewer may open (plus a global search across them).
    await this.registerConsole(mount, guard);
    router.get(`${apiBase}/consoles`, async (ctx) => {
      if (!(await enforceGuard(ctx as unknown as UiHttpContext, guard))) return;
      const body = await listVisibleConsoles(await readAgoraConsoles(this.app), CONSOLE_ID, ctx, {
        logger: ctx.logger,
      });
      ctx.response.header('cache-control', 'private, no-store');
      return ctx.response.json(body);
    });
    router.get(`${apiBase}/consoles/search`, async (ctx) => {
      if (!(await enforceGuard(ctx as unknown as UiHttpContext, guard))) return;
      const q = ctx.request.input('q', '');
      const body = await searchConsoles(
        await readAgoraConsoles(this.app),
        CONSOLE_ID,
        ctx,
        typeof q === 'string' ? q : '',
        { logger: ctx.logger },
      );
      ctx.response.header('cache-control', 'private, no-store');
      return ctx.response.json(body);
    });

    router.get(mount, async (ctx) => {
      if (!(await this.gate(ctx, guard, denial))) return;
      await this.sendIndex(ctx, mount, apiBase, dashboardConfig);
    });

    // Built assets (JS/CSS/fonts/...), with an index fallback for any unmatched path so the
    // client-rendered console still boots on a deep link. The static `<mount>/api/*` routes the core
    // provider registers take precedence over this wildcard in the router.
    router.get(`${mount}/*`, async (ctx) => {
      if (!(await this.gate(ctx, guard, denial))) return;
      const segments = safeAssetSegments(ctx.params['*']);
      if (segments === null) {
        return ctx.response.status(400).json({ error: 'bad asset path' });
      }
      await this.sendAsset(ctx, segments, mount, apiBase, dashboardConfig);
    });
  }

  /** Add Telescope to the `'agora.consoles'` registry (never fails the boot). */
  private async registerConsole(mount: string, guard: AuthorizeHook): Promise<void> {
    const authorize = async (ctx: HttpContext): Promise<AgoraConsoleDecision> => {
      try {
        const result = await runGuard(ctx as unknown as UiHttpContext, guard);
        if (result.allowed) return { allowed: true };
        return {
          allowed: false,
          reason: result.message ?? 'forbidden',
          ...(result.redirectTo !== undefined ? { redirectTo: result.redirectTo } : {}),
        };
      } catch {
        return { allowed: false, reason: 'forbidden' };
      }
    };
    try {
      const logger = await this.app.container.make('logger').catch(() => undefined);
      await registerAgoraConsole(
        this.app,
        {
          id: CONSOLE_ID,
          title: 'Telescope',
          package: '@adonis-agora/telescope',
          icon: 'telescope',
          path: mount,
          order: 20,
          authorize,
          search: telescopeConsoleSearch(
            () => (getTelescopeRuntime().store as SearchableStore | null) ?? null,
            mount,
          ),
        },
        logger,
      );
    } catch (error) {
      console.warn(
        `[@adonis-agora/telescope-ui] console switcher unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The console-shell fields of the page's data block (no `authorize` runs here): the switcher
   * (only when other consoles are registered), ⌘K search (whenever a console registry exists —
   * Telescope registers its own search, so it searches its own entries even when alone), the
   * signed-in viewer and the sign-out (the host's option, else the one an account console
   * announced on the registry). Each part fails closed: an error drops it, never the page.
   */
  private async shellConfig(
    apiBase: string,
    ctx: HttpContext,
    config: ResolvedTelescopeDashboardConfig,
  ): Promise<ShellFields> {
    const registry = await readAgoraConsoles(this.app).catch(() => null);
    const others = countOtherConsoles(registry, CONSOLE_ID);
    const viewer = await resolveViewer(ctx, config.viewer);
    const signOut = resolveSignOut(ctx, config.signOut, registry);
    return {
      ...(others > 0 ? { switcher: { endpoint: `${apiBase}/consoles`, others } } : {}),
      ...(registry ? { search: { endpoint: `${apiBase}/consoles/search` } } : {}),
      ...(viewer ? { viewer } : {}),
      ...(signOut ? { signOut } : {}),
    };
  }

  /**
   * Run `authorize` for a page navigation, mirroring the JSON API routes: a refused BROWSER gets
   * the access-denied page (or a `302` to `redirectTo`) rather than the API's JSON. Returns `true`
   * to proceed; on denial the guard has already written the response and this returns `false`.
   */
  private async gate(
    ctx: HttpContext,
    guard: AuthorizeHook,
    denial: PageGuardOptions,
  ): Promise<boolean> {
    const nonce = cspNonce(ctx);
    const options: PageGuardOptions = nonce !== undefined ? { ...denial, nonce } : denial;
    return enforcePageGuard(ctx as unknown as UiHttpContext, guard, options);
  }

  /**
   * Read `dist/spa/index.html`, rewrite its relative `./assets/*` URLs to absolute `<mount>/...`
   * (the SPA is a `base: './'` Vite build; see {@link rewriteRelativeAssets}), inject the API base,
   * and send it.
   */
  private async sendIndex(
    ctx: HttpContext,
    mount: string,
    apiBase: string,
    config: ResolvedTelescopeDashboardConfig,
  ): Promise<void> {
    const html = await readFile(new URL('index.html', this.spaDirUrl), 'utf8');
    ctx.response.header('content-type', 'text/html; charset=utf-8');
    ctx.response.header('cache-control', 'no-store, must-revalidate');
    const extra = await this.shellConfig(apiBase, ctx, config);
    ctx.response.send(injectApiBase(rewriteRelativeAssets(html, mount), apiBase, extra));
  }

  /** Send the requested built asset, or fall back to the SPA shell when it does not exist. */
  private async sendAsset(
    ctx: HttpContext,
    segments: string[],
    mount: string,
    apiBase: string,
    config: ResolvedTelescopeDashboardConfig,
  ): Promise<void> {
    const filename = segments[segments.length - 1] ?? 'index.html';
    try {
      const buffer = await readFile(new URL(segments.join('/'), this.spaDirUrl));
      ctx.response.header('content-type', contentTypeFor(filename));
      ctx.response.send(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.sendIndex(ctx, mount, apiBase, config);
        return;
      }
      throw error;
    }
  }
}

/**
 * The request's CSP nonce when the host runs `@adonisjs/shield` with `@nonce` in its policy (shield
 * exposes it as `response.nonce`). Read structurally: this package neither depends on shield nor
 * cares which middleware minted the nonce — only that the page's inline `<style>` carries it.
 */
function cspNonce(ctx: HttpContext): string | undefined {
  const nonce = (ctx.response as unknown as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}
