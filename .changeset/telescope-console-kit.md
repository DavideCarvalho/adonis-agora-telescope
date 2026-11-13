---
'@adonis-agora/telescope-ui': minor
'@adonis-agora/telescope': minor
---

Console shell: the Telescope console is rebuilt on the Agora console kit, the shell every `@adonis-agora` console now shares.

- Authkit's look with Telescope's magenta accent: Sora for the UI and JetBrains Mono only for data (the console no longer runs in monospace). Fonts are bundled; nothing loads from Google Fonts.
- Left sidebar with the console switcher and grouped nav: MONITOR (Overview, Pulse, Exceptions), EXPLORE (Entries, Traces, Screens, AI, Profiles), OPERATIONS (Queues, Schedules), DASHBOARDS (one item per contributed dashboard), WATCHERS (a collapsible list of entry types) and DATA (Exports). A footer shows the signed-in user, the light/dark toggle and sign-out. Below 768px the sidebar becomes a drawer.
- Topbar with the page title, the organization picker, the retention posture, the live indicator and ⌘K. ⌘K keeps every page, entry-type and dashboard jump the old command palette had, listed above the cross-console search.
- Light mode follows the kit's tokens. The theme key in `localStorage` is now `agora-telescope-theme`.
- Every page and data region has its own error boundary with a retry button, shaped skeletons and empty states.

Server: the page's data block gains `viewer` and `signOut`, and `search` is sent whenever a console registry exists. The new `dashboard.viewer(ctx)` option sets the user row; without it the console reads `ctx.auth.user` when the request is already authenticated. The new `dashboard.signOut` option takes a POST action path, `{ href }` or `false`; without it the console uses the sign-out an account console announces on the `agora.consoles` registry (`account.signOut`). A POST sign-out carries the request's CSRF token. `TelescopeUiConfig` gains the `dashboard` block type (`TelescopeDashboardOptions`).
