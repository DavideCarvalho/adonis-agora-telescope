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
}

export interface ResolvedTelescopeDashboardConfig {
  enabled: boolean;
  path?: string;
}

/** Fill defaults for the optional dashboard config block. */
export function resolveDashboardConfig(
  config: TelescopeDashboardConfig | undefined,
): ResolvedTelescopeDashboardConfig {
  const enabled = config?.enabled ?? true;
  return config?.path !== undefined ? { enabled, path: config.path } : { enabled };
}
