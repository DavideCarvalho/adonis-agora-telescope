# @agora/telescope-ui

A self-contained web dashboard + JSON API for [`@agora/telescope`](../core). It
mounts HTTP routes in your AdonisJS app that serve a JSON API over the headless
`TelescopeService` and a single, build-step-free HTML dashboard that consumes it —
all behind a configurable auth guard.

## Install

```sh
pnpm add @agora/telescope-ui
node ace configure @agora/telescope-ui
```

`configure` registers the provider in `adonisrc.ts` and publishes
`config/telescope_ui.ts`. The provider needs `@agora/telescope` to be installed and
enabled (the dashboard reads the live telescope store from the core runtime slot).

## Routes

All under the configured `path` (default `/telescope`):

| Method & path                  | Description                                              |
| ------------------------------ | ------------------------------------------------------- |
| `GET <path>`                   | The dashboard HTML page.                                 |
| `GET <path>/api/entries`       | List entries. `?type ?traceId ?search ?limit ?before`.  |
| `GET <path>/api/entries/:id`   | One entry with its full `content` (404 if absent).      |
| `GET <path>/api/trace/:traceId`| Every entry recorded under a trace id.                  |
| `GET <path>/api/stats`         | `{ count, topFamilies, topTags }`. `?type ?limit`.      |

Every route runs the configured `authorize` guard first; a denial answers `401`
(no credential presented) or `403` (a credential was presented and rejected).

## Dashboard

A single inline-CSS / vanilla-JS page (no bundler): a newest-first entry list with
a type filter, a search box, an auto-refresh toggle, live stats, and a click-through
detail view rendering the full `content` JSON. Dark, tidy, function over flash.

## Auth

`config/telescope_ui.ts` exposes an `authorize(ctx) => boolean | Promise<boolean>`
hook. When omitted, the default policy allows access outside production and
**denies in production** unless a configured credential is presented:

- `credentials.token` — `Authorization: Bearer <token>` or `?token=<token>`;
- `credentials.basic` — HTTP Basic auth.

Supply your own `authorize` to delegate to your app's auth (e.g.
`(ctx) => ctx.auth?.user?.isAdmin === true`).

## License

MIT
