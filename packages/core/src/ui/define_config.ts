import type {
  AccessDeniedInfo,
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
import type { UiHttpContext } from './http.js';

/**
 * The function form of {@link TelescopeUiConfig.accessDenied}: render (or answer) a refused page
 * navigation yourself. Receives the refusal ({@link AccessDeniedInfo}) and the (framework-light)
 * HTTP context — the real AdonisJS `HttpContext` at runtime, cast down like the `authorize` hook's.
 * Return an HTML string to have it served; answer the request yourself (a redirect, most commonly)
 * and return nothing to make the guard stand down; return nothing WITHOUT answering and the
 * built-in page is served.
 */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<UiHttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<UiHttpContext>;

/**
 * The enriched form of an {@link AuthorizeHook}'s return value: a plain `allowed` plus an OPTIONAL
 * `reason` telling the guard exactly which denial this is.
 *
 * This is the dashboard-gate contract shared (copied verbatim) by every `@adonis-agora` console —
 * telescope, durable, media, payments, agent, authz:
 * - `true` / `{ allowed: true }` → proceed.
 * - `{ allowed: false, reason: 'unauthenticated' }` → `401` (nobody is signed in).
 * - `{ allowed: false, reason: 'forbidden' }` → `403` (signed in, but not authorized).
 * - a bare `false`, or `{ allowed: false }` with no `reason` → `403` (fail closed).
 * - the hook throws → `403`.
 *
 * So a hook that wants the "please sign in" `401` (e.g. `@adonis-agora/authz`'s `authorizeByRoles`
 * for an anonymous visitor) must say so with `reason: 'unauthenticated'`. `reason` reuses the same
 * vocabulary as {@link AccessDeniedInfo.reason}, so a hook and a custom `accessDenied` renderer
 * speak the same two words.
 */
export interface AuthorizeDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Why `allowed` is `false`. Omitted on a denial → `403` (fail closed). */
  reason?: 'unauthenticated' | 'forbidden';
}

/**
 * What an {@link AuthorizeHook} may return, sync or async: a {@link ConsoleAuthorizeResult}
 * (`boolean`, `{ allowed, reason? }`, `{ redirectTo }`) or an {@link AuthorizeDecision}.
 */
export type AuthorizeResult = ConsoleAuthorizeResult | AuthorizeDecision;

/**
 * The resolved decision hook gating the dashboard + JSON API: what `resolveConfig` turns the
 * configured `authorize` (any {@link ConsoleAuthorize} form) into. Sync or async.
 *
 * A bare `false` is a `403`; `{ allowed: false, reason: 'unauthenticated' }` is a `401`;
 * `{ redirectTo }` is a `302` for a page navigation and a `401` for an API call. A hook may also
 * answer the request itself (e.g. `ctx.response.redirect('/login')`) and return `false`: the guard
 * then writes nothing.
 */
export type AuthorizeHook = (ctx: UiHttpContext) => AuthorizeResult | Promise<AuthorizeResult>;

/**
 * The shape of `config/telescope_ui.ts`. Everything is optional with sane
 * defaults: the dashboard is mounted at `/telescope`; without `authorize` it is open
 * outside production and answers `403` to every request in production.
 */
export interface TelescopeUiConfig {
  /**
   * Master switch. When `false`, the provider registers no routes at all (the
   * dashboard and JSON API simply do not exist). Default `true`.
   */
  enabled?: boolean;
  /**
   * URL prefix the dashboard + JSON API mount under. The dashboard page is served
   * at the prefix root; the JSON API lives at `<path>/api/*`. Default `/telescope`.
   */
  path?: string;
  /**
   * Record the dashboard's OWN requests as `request` entries. Default `false`.
   *
   * Off by default because the console is the loudest client of the app it observes:
   * its aggregation endpoints are among the slowest the process serves, because that
   * is their job. Left on, the "slowest routes" list ranks telescope's own endpoints
   * against the application's.
   *
   * Turn on only to debug the console itself.
   */
  recordOwnRequests?: boolean;
  /**
   * Who may open the console (shell and API), in any {@link ConsoleAuthorize} form:
   * - a function: `(ctx) => ctx.auth.user?.isAdmin === true`;
   * - a {@link ConsoleAuthorizer} class (built through the container, so `@inject()` works);
   * - a lazy import of such a class: `() => import('#policies/console_access')`;
   * - `authorizeByToken({ token: env.get('CONSOLE_TOKEN') })` for `Authorization: Bearer` access.
   *
   * When omitted, the console is open outside production and answers `403` to every request in
   * production (with one warning at boot).
   */
  authorize?: ConsoleAuthorize;

  /**
   * What a BROWSER sees when the guard refuses a page navigation — the `@adonis-agora/telescope-ui`
   * SPA shell or its assets. API requests are unaffected: they keep getting the JSON the SPA relies
   * on (`401`/`403 { error }`).
   *
   * Omit it for the built-in page — a dark card in the console's own visual language, with the
   * status, a sentence explaining the refusal and a "Back to app" link. Pass an object to tweak that page (`brand`, `title`, `message`,
   * `homeHref`, `loginHref`, `accent`, …), or a function to render/answer it yourself — see
   * {@link AccessDeniedRenderer}. Either way, an `authorize` hook that already wrote a redirect
   * still wins: the guard never overwrites a `location` header.
   */
  accessDenied?: AccessDeniedOption;

  // — request replay (additive: keep in its own region for trivial merges) —
  /**
   * Request REPLAY: re-issue a captured `request` entry against the LOCAL server
   * from the dashboard. DISABLED BY DEFAULT — replaying re-runs a real request
   * that may MUTATE state (a captured `POST`/`DELETE` runs again), so the host
   * must opt in. When disabled, the replay endpoint answers `403`. See
   * `src/ui/request_replay.ts` for the full safety posture (same-origin only,
   * credential stripping, bounded, self-identifying).
   */
  replay?: ReplayConfig;

  // — CPU profiling arm trigger (additive: keep in its own region for trivial merges) —
  /**
   * The `POST <path>/api/profiles/arm` trigger: DISABLED BY DEFAULT, like `replay` — arming a
   * capture incurs real CPU overhead (a running V8 sampling profiler on the next N requests), so the
   * host must opt in even when `@adonis-agora/telescope/cpu_profiling` itself is installed and
   * `enabled`. When disabled, the arm endpoint answers `403`. Purely a UI-mutation gate: reading
   * captured profiles (`GET .../profiles*`) is unaffected.
   */
  cpuProfiling?: { armEnabled?: boolean };

  // — live queue manager mutations (additive) —
  /**
   * The queue console's mutating actions (`retry`/`enqueue`): DISABLED BY DEFAULT, like `replay` —
   * they act on real jobs (retrying re-runs one, enqueueing dispatches a new one). Reading the queue
   * console (`GET .../queues/live*`) is unaffected; only `POST .../queues/live/*` is gated.
   */
  queueActions?: { enabled?: boolean };
}

/** Request-replay configuration (see {@link TelescopeUiConfig.replay}). */
export interface ReplayConfig {
  /** Master switch for replay. Default `false` (safe: replay disabled). */
  enabled?: boolean;
  /**
   * The local server port the replay targets (`127.0.0.1:<port>`). When omitted,
   * the `PORT` env var is used, falling back to 3333 (the AdonisJS default).
   */
  port?: number;
  /** Per-call timeout in ms. Default 30000. */
  timeoutMs?: number;
}

/** The fully-resolved config the provider acts on (no optionals on the basics). */
export interface ResolvedTelescopeUiConfig {
  enabled: boolean;
  /** Always a leading-slash, no-trailing-slash prefix, e.g. `/telescope`. */
  path: string;
  recordOwnRequests: boolean;
  authorize: AuthorizeHook;
  /** Whether the host configured `authorize` (when not, the production default denies everything). */
  authorizeConfigured: boolean;
  /** The host's `accessDenied` option as given, or `null` for the built-in page with defaults. */
  accessDenied: AccessDeniedOption | null;
  /** Resolved request-replay settings (disabled by default). */
  replay: { enabled: boolean; port?: number; timeoutMs?: number };
  /** Resolved CPU-profiling arm-trigger gate (disabled by default). */
  cpuProfiling: { armEnabled: boolean };
  /** Resolved queue-console mutation gate (disabled by default). */
  queueActions: { enabled: boolean };
}

/**
 * Identity helper giving `config/telescope_ui.ts` full type-checking. Mirrors the
 * AdonisJS `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope/ui'
 * export default defineConfig({ path: '/__telescope', authorize: (ctx) => true })
 * ```
 */
export function defineConfig(config: TelescopeUiConfig): TelescopeUiConfig {
  return config;
}

/** Normalize a prefix to a leading slash with no trailing slash (`/telescope`). */
export function normalizePath(path: string): string {
  let p = path.trim();
  if (p === '' || p === '/') return '/telescope';
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Whether the current process is running in production (used when the caller does not say). */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Options for {@link resolveConfig}. */
export interface ResolveUiConfigOptions {
  /** Whether the app runs in production (`app.inProduction`). Defaults to `NODE_ENV === 'production'`. */
  inProduction?: boolean;
}

/**
 * The warning logged once at boot when `authorize` is omitted and the app runs in production.
 *
 * @internal Used by the UI provider.
 */
export const MISSING_AUTHORIZE_WARNING =
  '[@adonis-agora/telescope] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/telescope_ui.ts.';

/** The default when `authorize` is omitted: open outside production, `403` in production. */
function defaultConsoleAuthorize(inProduction: boolean): AuthorizeHook {
  return () => !inProduction;
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(
  config: TelescopeUiConfig = {},
  options: ResolveUiConfigOptions = {},
): ResolvedTelescopeUiConfig {
  const inProduction = options.inProduction ?? isProduction();
  return {
    enabled: config.enabled ?? true,
    path: normalizePath(config.path ?? '/telescope'),
    recordOwnRequests: config.recordOwnRequests ?? false,
    authorize:
      config.authorize === undefined
        ? defaultConsoleAuthorize(inProduction)
        : resolveConsoleAuthorize(config.authorize),
    authorizeConfigured: config.authorize !== undefined,
    accessDenied: config.accessDenied ?? null,
    replay: {
      // Safe default: replay is OFF unless the host explicitly enables it.
      enabled: config.replay?.enabled ?? false,
      ...(config.replay?.port !== undefined ? { port: config.replay.port } : {}),
      ...(config.replay?.timeoutMs !== undefined ? { timeoutMs: config.replay.timeoutMs } : {}),
    },
    cpuProfiling: {
      // Safe default: arming is OFF unless the host explicitly enables it.
      armEnabled: config.cpuProfiling?.armEnabled ?? false,
    },
    queueActions: {
      // Safe default: queue mutations are OFF unless the host explicitly enables them.
      enabled: config.queueActions?.enabled ?? false,
    },
  };
}
