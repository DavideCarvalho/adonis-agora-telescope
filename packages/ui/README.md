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
  list, and the pretty-printed `content`. Exception/`client_exception` entries additionally get an
  **AI diagnosis** panel (shown only when `@adonis-agora/telescope/ai` is installed and configured) —
  "Diagnose with AI" calls the Anthropic-backed `DiagnosisCoordinator` and renders a probable cause +
  suggested fix, cached by exception family so re-opening the same error doesn't burn a second model
  call. `request` entries get a **Replay** action that re-issues the captured request against the live
  server (disabled by default server-side; the panel surfaces why when it is).
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

Tailwind + a vendored shadcn-style component layer on [Base UI](https://base-ui.com) (`button`,
`badge`, `dialog`, `tabs`, `tooltip`, `popover`, `input`, `select`, `table` — `src/app/primitives/`),
on the **Aviary** design tokens shared across the Agora ecosystem's consoles — same neutrals/status
hues as `@dudousxd/nestjs-telescope-ui` (this dashboard's NestJS sibling), same magenta `--accent`,
so the two Telescope dashboards match pixel-for-pixel regardless of host framework. Dark-mode-first
with a `.light`-class override (persisted to `localStorage`), responsive. Still dependency-light where
it counts: hand-rolled SVG sparklines and a CSS waterfall (a dense, grid-based timeline that loses
legibility as pure utilities), a tiny `useAsync` instead of a query library, and native `EventSource`
for the live tail — no react-router, no charting library, no table library.
