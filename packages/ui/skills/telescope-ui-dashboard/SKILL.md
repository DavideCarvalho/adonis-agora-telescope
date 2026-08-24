---
name: telescope-ui-dashboard
description: >-
  Mount and consume the @adonis-agora/telescope-ui observability console for
  @adonis-agora/telescope — register telescope_ui_dashboard_provider AFTER ui_provider
  in adonisrc.ts, the pre-built React SPA's ten sections (overview, entries + live
  tail, traces/waterfall, Pulse, exception groups, live queues/schedules, exports,
  CPU profiles, extensions), the dependency-free TelescopeClient from /client,
  GET /api/meta capability discovery, mutation gates (replay/arm/retry/enqueue), and
  client-side JSON/CSV exports. Use for "show the dashboard", "telescope 404",
  "query the telescope API from my own UI", "embed telescope data".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope-ui"
  library_version: "1.0.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/packages/telescope-ui.mdx"
  - "DavideCarvalho/adonis-telescope:docs/dashboard/index.mdx"
  - "DavideCarvalho/adonis-telescope:packages/ui/package.json"
---

# The @adonis-agora/telescope-ui console

`@adonis-agora/telescope-ui` is a **separate package**: the React single-page app
that renders what Telescope captured. A thin AdonisJS provider serves the pre-built
SPA under the same prefix (`config('telescope_ui').path`, default `/telescope`) and
behind the same auth guard as the core `<path>/api/*` JSON API it reads.

## Setup

```sh
pnpm add @adonis-agora/telescope @adonis-agora/telescope-ui
node ace configure @adonis-agora/telescope   # pick "UI" — registers ui_provider + config/telescope_ui.ts
```

Register the SPA provider **after** the core providers in `adonisrc.ts`:

```ts
// adonisrc.ts
providers: [
  // ...
  () => import('@adonis-agora/telescope/telescope_provider'),
  () => import('@adonis-agora/telescope/ui_provider'),                    // JSON API + SSE under <path>/api/*
  () => import('@adonis-agora/telescope-ui/telescope_ui_dashboard_provider'), // the SPA at <path>
]
```

Open `http://localhost:3333/telescope`. It is reachable automatically outside
production; in production it is denied until you set a credential or an `authorize`
hook in `config/telescope_ui.ts` (see the `telescope-access-mcp` skill).

Source: `docs/packages/telescope-ui.mdx` (Install),
`docs/getting-started.mdx` (Step 6).

## Core patterns

### Pattern 1 — override or toggle the SPA mount

The SPA reuses the core `config/telescope_ui.ts` block; an optional nested
`dashboard` block only toggles it on/off or re-mounts it elsewhere:

```ts
// config/telescope_ui.ts
import { defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  path: '/telescope',
  credentials: { token: process.env.TELESCOPE_UI_TOKEN },
  dashboard: {
    enabled: true,
    // path: '/__telescope',   // serve the SPA from a different prefix than the API
  },
})
```

The core provider's static API routes take precedence over the SPA wildcard, so
`<path>/api/*` always wins.

Source: `docs/packages/telescope-ui.mdx` (Configuration, How it mounts).

### Pattern 2 — read telescope data from your own front end

`@adonis-agora/telescope-ui/client` ships the typed fetch client the console itself
uses — no React, no dependencies. Requests are same-origin, inheriting whatever
session already gates the dashboard.

```ts
import { TelescopeClient } from '@adonis-agora/telescope-ui/client'

const client = new TelescopeClient({ baseUrl: '/telescope/api' })

const entries = await client.listEntries({ type: 'exception', limit: 20 })
const entry = await client.getEntry(entries[0].id)
const story = await client.entriesByTrace(entry.traceId!)
const pulse = await client.pulse(15 * 60_000)
const meta = await client.meta()          // capability discovery: ai / profiling / queueManager flags
```

Reading methods that target missing features resolve to `null`
(`liveQueues`, `queueJob`, `profilerStatus`) rather than throwing; everything else
throws a `TelescopeApiError` carrying the HTTP status.

Source: `docs/packages/telescope-ui.mdx` (The client).

### Pattern 3 — act through the gated endpoints

The five acting methods never reject on an HTTP error — they resolve to
`{ ok: true, ... } | { ok: false, message }`, because "replay is disabled here" is
something to render, not an exception to catch.

```ts
const replay = await client.replayRequest(entryId)      // needs ui replay.enabled
if (!replay.ok) console.warn(replay.message)            // e.g. disabled → render, don't catch

const diagnosis = await client.diagnoseException(entryId) // needs the AI subpath configured
const armed = await client.armProfile(3, 'GET /users/:id') // needs cpuProfiling.armEnabled

new EventSource(client.streamUrl())                     // SSE live tail of new entries
```

Every gate defaults to off in `config/telescope_ui.ts`; the console asks
`<path>/api/meta` and renders which config key turns each surface on.

Source: `docs/packages/telescope-ui.mdx` (Acting on an entry, Getting around).

### Pattern 4 — format numbers exactly like the console

Presentation helpers ship from the same subpath, so custom UIs render identically:

```ts
import {
  ENTRY_TYPES,             // the twelve built-in entry types
  formatDuration,          // '4.2ms', '1m 3s'
  formatPercent,           // 0.0473 → '4.7%'
  formatRelative,          // '12s ago'
} from '@adonis-agora/telescope-ui/client'

formatDuration(840)        // '840µs'
formatDuration(1240)       // '1.24s'
formatPercent(0.0473)      // '4.7%'
formatRelative(iso)        // '12s ago'
ENTRY_TYPES                // ['request','query','exception','client_exception','job',
                           //  'mail','cache','redis','event','log','http-client','diagnostic']
```

`Entry['type']` is a plain string, so custom watchers/extensions can record types
outside that tuple.

Source: `docs/packages/telescope-ui.mdx` (Helpers).

## Common mistakes

### HIGH Opening /telescope with only the core installed

```sh
# Wrong — the core ui subpath serves <path>/api/* and nothing else.
pnpm add @adonis-agora/telescope
node ace configure @adonis-agora/telescope   # picked "UI" — still no page!
open http://localhost:3333/telescope         # 404
```

```sh
# Correct — the SPA is its own package; install and register it too.
pnpm add @adonis-agora/telescope-ui
```

Mechanism: the console holds no server-side state of its own; without this package
there is no page at all — the prefix exposes just the JSON API by design.
Source: `docs/packages/telescope-ui.mdx` (warn callout), `docs/packages/ui.mdx` (Install).

### HIGH Registering the SPA provider before ui_provider

```ts
// Wrong — the console consumes the core UI JSON API; registered first it has no backend.
providers: [
  () => import('@adonis-agora/telescope-ui/telescope_ui_dashboard_provider'),
  () => import('@adonis-agora/telescope/ui_provider'),
]
```

```ts
// Correct — core first, then the dashboard provider.
providers: [
  () => import('@adonis-agora/telescope/ui_provider'),
  () => import('@adonis-agora/telescope-ui/telescope_ui_dashboard_provider'),
]
```

Mechanism: the docs require registering after the core telescope providers because
the SPA's `<path>/api/*` calls must line up with routes the `ui_provider` mounts;
it also serves nothing when `config('telescope_ui').enabled` is false.
Source: `docs/packages/telescope-ui.mdx` (Install), `docs/getting-started.mdx` Step 6.

### HIGH Expecting replay/arm/retry buttons to work out of the box

```ts
// Wrong — features enabled but their actions still 403:
defineConfig({ replay: { enabled: false } })   // default; POST .../replay answers 403
```

```ts
// Correct — flip each mutation gate explicitly in config/telescope_ui.ts:
defineConfig({
  replay: { enabled: true },
  cpuProfiling: { armEnabled: true },
  queueActions: { enabled: true },
})
```

Mechanism: replaying re-runs a real request (a captured POST/DELETE mutates state),
arming triggers real profiler overhead, and queue actions touch live jobs — so each
is disabled independently of whether its feature is installed.
Source: `docs/packages/ui.mdx` (Configuration + Request replay),
`docs/packages/cpu-profiling.mdx` (arm callout).

### MEDIUM try/catching the client's acting methods

```ts
// Wrong — these never reject; the catch never fires and errors look like successes.
try {
  const result = await client.retryJob(queue, id)
} catch (e) {
  showRetryFailed()   // dead code — HTTP failures resolve, not throw
}
```

```ts
// Correct — branch on the discriminated result.
const result = await client.retryJob(queue, id)
if (result.ok) toast('Retrying') else toast(result.message)
```

Mechanism: `diagnoseException`, `replayRequest`, `armProfile`, `retryJob` and
`enqueueJob` resolve `{ ok: false, message }` instead of rejecting; only the reading
methods throw `TelescopeApiError`.
Source: `docs/packages/telescope-ui.mdx` (info callout under Acting on an entry).

### MEDIUM Expecting exported files to contain entry content

```ts
// Wrong — assuming CSV export includes SQL bodies / stacks for offline analysis.
await client.listEntries({ type: 'query', search: 'users', limit: 500 })
// then expecting `content` in the downloaded file
```

Mechanism: exports are entirely client-side list projections — the same rows the
Entries table shows (id, type, createdAt, durationMs, tags, familyHash, traceId,
summary). Content is searched server-side but never written into the file.
Source: `docs/packages/telescope-ui.mdx` (Exports).

See also: `telescope-setup/SKILL.md` — installing the core this package depends on;
`telescope-access-mcp/SKILL.md` — the guard and mutation gates behind every route.
