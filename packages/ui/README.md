# @adonis-agora/telescope-ui

The observability **dashboard** for [`@adonis-agora/telescope`](../core) — a dependency-light React
SPA served by a thin AdonisJS provider, behind the **same** auth guard as the JSON API it consumes.
Part of the Agora ecosystem.

## What it shows

- **AI** — AI spend (total, platform and estimated shares, by feature / model / payer, over time),
  agent runs with queue / model / tools timings and a per-step breakdown linked to the trace, and
  unpriced calls, from `@adonis-agora/agent` ≥ 0.93.0's `usage.recorded` and `run.*` events.
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

Built on the Agora console kit (`src/agora-kit/`, copied verbatim into every `@adonis-agora`
console): React 19, Tailwind 4 and vendored shadcn/ui components on [Base UI](https://base-ui.com),
with the `--agora-*` tokens (dark and light), Telescope's magenta accent (`#e879f9`), and bundled
Sora (UI) and JetBrains Mono (data) fonts — no Google Fonts request. The shell is the kit's: a
sidebar with the console switcher and grouped nav (a drawer on phones), a topbar with the
organization picker, retention, the live dot and ⌘K, and a footer with the signed-in user, the
theme toggle and sign-out. Every page and data region renders through an error boundary, with
shaped skeletons and empty states. Data loading goes through TanStack Query and tables through
TanStack Table; sparklines, the waterfall and the flamegraph are hand-rolled, and the live tail is
a native `EventSource`.
