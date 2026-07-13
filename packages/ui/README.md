# @adonis-agora/telescope-ui

The observability **dashboard** for [`@adonis-agora/telescope`](../core) — a dependency-light React
SPA served by a thin AdonisJS provider, behind the **same** auth guard as the JSON API it consumes.
Part of the Agora ecosystem.

## What it shows

- **Pulse** — the `getHealth` "at a glance" rollup: throughput, error rate, p99 latency, HTTP status
  breakdown, slowest entries, slow routes, top exceptions, N+1 hotspots, load-by-user, cache hit ratio.
- **Entries** — the entries list with type + free-text filters and an **SSE live tail** that prepends
  new entries as they are recorded. Rows deep-link to the entry detail and the trace waterfall.
- **Entry detail** — the full entry: a type-aware header (method/url/status for requests), a metadata
  list, and the pretty-printed `content`.
- **Traces** — recent traces with their type mix, plus a per-trace **waterfall** (hand-rolled, no chart
  library) and a trace-scoped entries view.
- **Exceptions** — exception groups (class + message) over a window, with counts and trend sparklines.

It is a **pure consumer** of the telescope core's real routes under `<path>/api/*` (`/entries`,
`/entries/:id`, `/trace/:id`, `/metrics/{pulse,stats,traces,waterfall,n-plus-one}`) and the SSE live
stream at `<path>/api/stream`. No bundled API, no NestJS module.

## Install

```ts
// adonisrc.ts — after the core telescope providers
providers: [
  // …
  () => import('@adonis-agora/telescope/telescope_provider'),
  () => import('@adonis-agora/telescope/ui_provider'),          // JSON API + SSE under <path>/api/*
  () => import('@adonis-agora/telescope-ui'),                   // serves the SPA at <path>
]
```

The SPA mounts at `config('telescope_ui').path` (default `/telescope`) and reuses that block's
`authorize` guard. Toggle it or override the mount with the optional `telescope_ui.dashboard` block:

```ts
// config/telescope_ui.ts
import { defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  path: '/telescope',
  // authorize: (ctx) => ctx.auth.user?.isAdmin === true,
  // dashboard: { enabled: true, path: '/telescope' },
})
```

## Design

Agora design tokens (AdonisJS violet on a dusk-ink canvas, warm-paper in light), theme-aware
(`prefers-color-scheme` + a `data-theme` toggle), responsive, and dependency-light: hand-rolled SVG
sparklines and a CSS waterfall, a tiny `useAsync` instead of a query library, and native `EventSource`
for the live tail.
