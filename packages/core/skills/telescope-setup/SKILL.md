---
name: telescope-setup
description: >-
  Set up @adonis-agora/telescope in an AdonisJS app. Covers node ace configure
  codemods (telescope_provider + TelescopeMiddleware on the server stack +
  config/telescope.ts), defineConfig keys (enabled/store/stores/watchers/redact),
  the storage.memory and storage.lucid drivers, the headless TelescopeService query
  API (list/find/byTrace/count/topFamilies/topTags/getHealth), recordException for
  non-HTTP paths, opt-in requestCapture body gates, and why /telescope 404s without
  @adonis-agora/telescope-ui. Use for "install telescope", "telemetry is empty",
  "query captured entries", "capture request bodies", "AdonisJS observability".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "0.8.4"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:README.md"
  - "DavideCarvalho/adonis-telescope:docs/getting-started.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/core.mdx"
  - "DavideCarvalho/adonis-telescope:docs/reference/configuration.mdx"
---

# Setting up @adonis-agora/telescope

`@adonis-agora/telescope` is Laravel Telescope-style **headless** observability for
AdonisJS: it records every inbound HTTP request, every unhandled exception and every
`agora:<lib>:<event>` diagnostics publish as a queryable `Entry`. The core ships no
page — mounting a UI is a separate package (`telescope-ui-dashboard` skill).

## Setup

```sh
pnpm add @adonis-agora/telescope
node ace configure @adonis-agora/telescope
```

`configure` runs codemods that register `@adonis-agora/telescope/telescope_provider`
in `adonisrc.ts`, plug `TelescopeMiddleware` onto the **server** middleware stack
(so it wraps the whole pipeline and observes the final status), and publish
`config/telescope.ts`. That alone records `request` + `diagnostic` entries.

The published config is all-defaults:

```ts
// config/telescope.ts
import { defineConfig, storage } from '@adonis-agora/telescope'

export default defineConfig({
  enabled: true,                          // master switch
  store: 'memory',                        // which driver in `stores` is active
  stores: {
    memory: storage.memory({ limit: 1000 }),   // bounded ring buffer, lost on restart
    // lucid: storage.lucid({ connection: 'pg' }), // persistent SQL store (optional peer)
  },
  watchers: ['request', 'diagnostics'],   // omit one to disable it
})
```

Read entries back from anywhere via the container:

```ts
import { TelescopeService } from '@adonis-agora/telescope'

const telescope = await app.container.make(TelescopeService)

await telescope.list({ type: 'request', limit: 50 })   // newest-first
await telescope.byTrace('abc123')                       // one request's whole story
await telescope.list({ tag: 'lib:billing', search: 'invoice' })
await telescope.topFamilies(10, 'diagnostic')           // busiest lib:event pairs
```

## Core patterns

### Pattern 1 — the headless API inside a controller

Controllers have no `app` of their own; use `@inject()` so the container resolves
the constructor dependency.

```ts
// app/controllers/inspector_controller.ts
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { TelescopeService } from '@adonis-agora/telescope'

@inject()
export default class InspectorController {
  constructor(private telescope: TelescopeService) {}

  async index({ response }: HttpContext) {
    return response.json(await this.telescope.list({ limit: 50 }))
  }
}
```

`EntryQuery` composes filters with AND: `{ type, tag, familyHash, traceId, before,
after, search, limit }`. `search` matches JSON content **and** tags, so a request
matches by url, a diagnostic by event name, a query by SQL — all from one box.
For React usage in a custom console, see the `telescope-ui-dashboard` skill.

Source: `docs/getting-started.mdx` (Step 3).

### Pattern 2 — manual exception capture outside HTTP

Queue workers, ace commands and `app/exceptions/handler.ts` are not wrapped by the
middleware. `recordException` reads the live store with nothing injected, is a no-op
when Telescope is off, and never throws.

```ts
// app/exceptions/handler.ts
import { recordException } from '@adonis-agora/telescope'

async report(error: unknown, ctx: HttpContext) {
  recordException(error, { method: ctx.request.method(), url: ctx.request.url() })
  return super.report(error, ctx)
}
```

Exceptions group by `exceptionFamilyHash` = `name:message:topStackFrame`, so alerts
and the dashboard's exception groups stay deterministic across processes.

Source: `docs/concepts/capture.mdx` (Manual capture), `docs/packages/core.mdx`.

### Pattern 3 — opt-in request-body capture

By default a `request` entry has **no `body` field at all**. Turn it on with gates
that run before redaction; a rejected body becomes a marker string like
`[Skipped: 200000 bytes > 131072 bytes]`.

```ts
// config/telescope.ts
export default defineConfig({
  requestCapture: {
    maxBodyBytes: 65_536,
    skipBodyContentTypes: ['multipart/form-data'],
    skipBody: ({ url }) => url.startsWith('/webhooks/'),
  },
})
```

Captured bodies still pass through central redaction — but a body never captured is
the only body that definitely cannot leak.

Source: `docs/packages/core.mdx` (Request body capture).

### Pattern 4 — production storage

Switch to the built-in Lucid driver when entries must survive restarts (see the
`telescope-storage-retention` skill for the migration and pruning):

```sh
pnpm add @adonisjs/lucid
node ace migration:run   # create_telescope_entries_table, shipped by configure
```

```ts
export default defineConfig({
  store: 'lucid',
  stores: { lucid: storage.lucid() },   // or storage.lucid({ connection: 'pg' })
})
```

Source: `docs/getting-started.mdx` (Step 4).

## Common mistakes

### HIGH Expecting a dashboard page from the core alone

```ts
// Wrong — nothing mounts a page; http://localhost:3333/telescope answers 404.
// adonisrc.ts
providers: [
  () => import('@adonis-agora/telescope/telescope_provider'),
  // ...app providers
]
```

```ts
// Correct — install @adonis-agora/telescope-ui and register its provider AFTER ui_provider.
providers: [
  () => import('@adonis-agora/telescope/telescope_provider'),
  () => import('@adonis-agora/telescope/ui_provider'),                  // JSON API + SSE
  () => import('@adonis-agora/telescope-ui/telescope_ui_dashboard_provider'), // the SPA
]
```

Mechanism: the core `ui` subpath serves only `<path>/api/*`; the prefix root belongs
to the separate SPA package, whose provider must also be registered after it.
Source: `docs/packages/ui.mdx` (Install), `docs/packages/telescope-ui.mdx` (warn).

### HIGH Assuming request bodies are captured by default

```ts
// Wrong — agents assume they can read the payload that broke checkout:
const entry = await telescope.find(id)
entry.content.body // undefined — bodies are opt-in
```

```ts
// Correct — enable requestCapture explicitly (gates run before redaction).
defineConfig({
  requestCapture: { maxBodyBytes: 65_536 },
})
```

Mechanism: the right default keeps passwords/card numbers out of storage; the entry
records method/url/status/duration only until you opt in per environment.
Source: `docs/packages/core.mdx` (Request body capture).

### HIGH Hand-rolling the provider without the server-stack middleware

```ts
// Wrong — provider registered but TelescopeMiddleware missing: no requests recorded,
// no exceptions captured, and nothing warns about it.
providers: [
  () => import('@adonis-agora/telescope/telescope_provider'),
]
```

```sh
# Correct — let the configure codemod wire both pieces.
node ace configure @adonis-agora/telescope
# verifies: telescope_provider present AND TelescopeMiddleware on the server stack
```

Mechanism: capture comes from `TelescopeMiddleware` on the `server` middleware
stack; the provider alone starts only the boot-time watchers, so the timeline stays
empty while everything looks installed.
Source: `docs/reference/configuration.mdx` (Providers table), `docs/getting-started.mdx` Step 1.

### MEDIUM Resolving TelescopeService via this.app inside a controller

```ts
// Wrong — a controller has no `app`; this does not compile.
constructor(private app: ApplicationService) {}
async index() {
  const telescope = await this.app.container.make(TelescopeService)
}
```

```ts
// Correct — constructor injection through @inject().
@inject()
export default class InspectorController {
  constructor(private telescope: TelescopeService) {}
}
```

Mechanism: `@inject()` asks the container to build the controller's dependencies
from their constructor types; `TelescopeService` arrives already resolved.
Source: `docs/getting-started.mdx` (Step 3 note).

See also: `telescope-ui-dashboard/SKILL.md` — mounting the page this setup lacks;
`telescope-storage-retention/SKILL.md` — swapping the dev-only memory driver.
