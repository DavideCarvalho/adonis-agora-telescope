import type { ConsoleViewer, SignOutOption, ViewerHook } from './console_shell.js';

/**
 * The dashboard SPA reuses the core `telescope_ui` config block (`config/telescope_ui.ts`) for its
 * mount `path` and its `authorize` guard, so the SPA sits behind the EXACT SAME auth as the JSON API
 * it consumes. This optional block only toggles the SPA on/off and, when a host wants the SPA served
 * from somewhere other than the `telescope_ui` prefix, overrides the mount path.
 */
export interface TelescopeDashboardConfig {
  /** Mount the SPA. Default `true` — set `false` to keep the static routes off entirely. */
  enabled?: boolean;
  /**
   * Override the mount path. Defaults to the resolved `telescope_ui.path` (e.g. `/telescope`) so the
   * SPA and the JSON API share a prefix and the SPA's `<path>/api/*` calls line up.
   */
  path?: string;
  /**
   * Who the console's sidebar footer shows as signed in. Omit it to read `ctx.auth.user`
   * structurally (`fullName`/`name`/`email`, first of `role`/`roles`) when the request is already
   * authenticated; return `null` for no user row. A throw is treated as `null`.
   */
  viewer?: ViewerHook;
  /**
   * The footer's "Sign out": a POST action path (`'/logout'`, sent with the CSRF token), `{ href }`
   * for a plain link, or `false` for none. Omit it to use the sign-out an account console (authkit)
   * announces on the `agora.consoles` registry, when there is one. Same-origin paths only.
   */
  signOut?: SignOutOption;
}

export type { ConsoleViewer, SignOutOption, ViewerHook };

export interface ResolvedTelescopeDashboardConfig {
  enabled: boolean;
  path?: string;
  /** The host's `viewer` hook, or `null` for the structural `ctx.auth.user` read. */
  viewer: ViewerHook | null;
  /** The host's `signOut` option, or `null` for the registry's announced one. */
  signOut: SignOutOption | null;
}

/** Fill defaults for the optional dashboard config block. */
export function resolveDashboardConfig(
  config: TelescopeDashboardConfig | undefined,
): ResolvedTelescopeDashboardConfig {
  const enabled = config?.enabled ?? true;
  const shell = { viewer: config?.viewer ?? null, signOut: config?.signOut ?? null };
  return config?.path !== undefined
    ? { enabled, path: config.path, ...shell }
    : { enabled, ...shell };
}
