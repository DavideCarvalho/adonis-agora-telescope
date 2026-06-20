---
"@agora/telescope-ui": minor
---

Initial release of the web dashboard + JSON API for `@agora/telescope`. Mounts HTTP
routes in your AdonisJS app that serve a JSON API over the headless
`TelescopeService` and a single, build-step-free HTML dashboard that consumes it,
all behind a configurable auth guard. Ships:

- JSON API handlers (`TelescopeApi`) — `GET <path>/api/entries` (filters:
  `type`/`traceId`/`search`/`tag`/`limit`/`before`), `GET .../entries/:id`,
  `GET .../trace/:traceId`, and `GET .../stats` (`count` + `topFamilies` +
  `topTags`). Framework-light: handlers take a minimal request/response shape (an
  Adonis `HttpContext` satisfies it structurally), so they are unit-testable with a
  plain object — no running HTTP server.
- A self-contained `dashboard.html` (inline CSS + vanilla JS, no bundler) rendered
  with an injected API base path: newest-first entry list, type filter, search box,
  auto-refresh toggle, live stats, and a click-through detail view of the full
  `content` JSON. Dark, tidy, function over flash.
- A configurable auth guard. `config/telescope_ui.ts` exposes
  `authorize(ctx) => boolean | Promise<boolean>`; the default policy allows access
  outside production and denies in production unless a configured `token` /
  `basic` credential is presented. Denials answer `401` (no credential) or `403`
  (rejected credential); a throwing hook fails closed.
- A provider that, on boot, resolves the runtime telescope store and registers the
  dashboard page + JSON endpoints under a configurable prefix (default `/telescope`)
  via the AdonisJS router, each behind the guard. Ships `configure.ts` + stub.
