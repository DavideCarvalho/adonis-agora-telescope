import {
  type DashboardAuthOptions,
  type ResolvedDashboardAuth,
  resolveDashboardAuth,
} from './auth.js';
import type { UiHttpContext } from './http.js';

/**
 * The decision hook gating the dashboard + JSON API. Return `true` to allow the
 * request through, `false` to reject it (the guard answers 401/403). It receives
 * the (framework-light) HTTP context, so a host can inspect headers, a session,
 * an injected user — whatever its own auth exposes. Sync or async.
 */
export type AuthorizeHook = (ctx: UiHttpContext) => boolean | Promise<boolean>;

/**
 * Built-in credential gate used by the default {@link AuthorizeHook} when no
 * custom `authorize` is supplied. When set, a request is allowed in production
 * only if it presents the matching credential; otherwise the default policy is
 * "allow only outside production".
 */
export interface UiCredentials {
  /**
   * A bearer/opaque token. A request is allowed when it carries
   * `Authorization: Bearer <token>` OR `?token=<token>` matching this value.
   */
  token?: string;
  /** HTTP Basic credentials (`Authorization: Basic <base64(user:pass)>`). */
  basic?: { username: string; password: string };
}

/**
 * The shape of `config/telescope_ui.ts`. Everything is optional with sane
 * defaults: the dashboard is mounted at `/telescope`, and access is allowed
 * automatically outside production (and denied in production unless a `token` /
 * `basic` credential — or a custom `authorize` hook — says otherwise).
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
   * The access-decision hook. When omitted, the default policy is used: allow when
   * not in production, otherwise require a configured {@link UiCredentials}. Provide
   * this to delegate to your own app auth (e.g. `ctx.auth.user?.isAdmin === true`).
   */
  authorize?: AuthorizeHook;
  /**
   * Built-in credentials for the default policy (ignored when a custom `authorize`
   * is supplied). Lets you gate a production dashboard without writing a hook.
   */
  credentials?: UiCredentials;

  /**
   * Optional built-in login screen. When set, the provider mounts a server-rendered
   * `GET <path>/login` page plus `POST <path>/login` / `GET <path>/logout`, and stamps a session
   * guard on the dashboard: an unauthenticated page navigation is redirected (`302`) to the login
   * page and an unauthenticated API request gets `401`. The signed session cookie is minted only by
   * the host's {@link DashboardAuthOptions.login} hook.
   *
   * This is ADDITIVE and composes WITH {@link authorize} (both must pass) — it does not replace it.
   * Omit it entirely to keep today's behavior byte-for-byte (no login/logout routes, no session
   * guard). Missing `secret`/`login` fails closed at boot.
   */
  dashboardAuth?: DashboardAuthOptions;

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
  authorize: AuthorizeHook;
  credentials: UiCredentials;
  /** Resolved built-in login config, or `null` when `dashboardAuth` is unconfigured. */
  dashboardAuth: ResolvedDashboardAuth | null;
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

/** Whether the current process is running in production. */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Constant-time-ish string compare to avoid trivially leaking length/timing of a
 * configured secret. Not a substitute for a real auth system, but better than `===`
 * for a dev-tool credential check.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Pull a bearer token from `Authorization: Bearer …` or `?token=…`. */
function readToken(ctx: UiHttpContext): string | undefined {
  const auth = ctx.request.header('authorization');
  if (auth !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  const qsToken = ctx.request.qs().token;
  return typeof qsToken === 'string' ? qsToken : undefined;
}

/** Decode and compare `Authorization: Basic …` against configured credentials. */
function matchesBasic(ctx: UiHttpContext, basic: { username: string; password: string }): boolean {
  const auth = ctx.request.header('authorization');
  if (auth === undefined) return false;
  const match = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (match?.[1] === undefined) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  return safeEqual(username, basic.username) && safeEqual(password, basic.password);
}

/**
 * The default access policy used when no custom `authorize` is configured:
 *
 * - if a `token` credential is set and the request presents it → allow;
 * - if `basic` credentials are set and the request presents them → allow;
 * - otherwise allow only when NOT in production (so a dev dashboard "just works"
 *   while a production deploy is denied unless explicitly gated).
 */
export function defaultAuthorize(credentials: UiCredentials): AuthorizeHook {
  return (ctx) => {
    if (credentials.token !== undefined) {
      const presented = readToken(ctx);
      if (presented !== undefined && safeEqual(presented, credentials.token)) return true;
    }
    if (credentials.basic !== undefined && matchesBasic(ctx, credentials.basic)) return true;
    return !isProduction();
  };
}

/** Apply defaults to a (possibly partial) config. */
export function resolveConfig(config: TelescopeUiConfig = {}): ResolvedTelescopeUiConfig {
  const credentials = config.credentials ?? {};
  return {
    enabled: config.enabled ?? true,
    path: normalizePath(config.path ?? '/telescope'),
    authorize: config.authorize ?? defaultAuthorize(credentials),
    credentials,
    // Validate + resolve now so a misconfigured secret/login fails closed at boot, not on the first
    // login attempt. `null` when `dashboardAuth` is omitted (behavior unchanged).
    dashboardAuth: resolveDashboardAuth(config.dashboardAuth),
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
