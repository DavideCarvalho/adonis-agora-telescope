---
name: telescope-access-mcp
description: >-
  Dashboard access control and the MCP endpoint in @adonis-agora/telescope —
  config/telescope_ui.ts authorize (function, class or lazy import),
  authorizeByToken({ token }) for Bearer access, { redirectTo } to the app's own
  login, the default (open outside production, 403 in production with a boot
  warning), 401-vs-403 guard semantics, redirect-wins behaviour,
  replay/queueActions/cpuProfiling.armEnabled mutation gates, Telescope's MCP tools on
  the Agora dev endpoint /mcp/agora (gated by the console's authorize), and the opt-in
  standalone config/telescope_mcp.ts endpoint (enabled: true). Use for
  "lock down the dashboard", "dashboard open in production", "401 on /telescope",
  "send to login", "expose telescope to Claude Code", "replay returns 403".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "1.0.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/dashboard/auth.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/mcp.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/ui.mdx"
---

# Dashboard access control & MCP

Every route serving recorded data runs an `authorize` guard first — every
`<path>/api/*` endpoint, the SSE stream, metrics and the SPA routes. Without
`authorize` the console is **open outside production and answers `403` to every
request in production**, logging one warning at boot. The console has no login of
its own: people sign in through the app. Coding agents reach Telescope's MCP tools on
the Agora dev endpoint `/mcp/agora`, behind the console's `authorize`; the standalone
`/telescope/mcp` endpoint is opt-in (`enabled: true` in `config/telescope_mcp.ts`).

## Setup

The simplest production gate for machines is `authorizeByToken`:

```ts
// config/telescope_ui.ts
import env from '#start/env'
import { authorizeByToken, defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  enabled: true,
  path: '/telescope',
  authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
})
```

```sh
curl -H 'Authorization: Bearer s3cr3t' http://localhost:3333/telescope/api/entries
```

Only the `Authorization: Bearer` header is read (no `?token=`). A missing token
throws when the config loads. With tenancy on, pass `tenants` (`'*'` or ids) —
a token carries no signed-in organization, so without it it sees none.
Source: `docs/dashboard/auth.mdx` (Token access).

## Core patterns

### Pattern 1 — delegate to your app's auth

`authorize` is the whole policy. It receives the request's `HttpContext`, and also
accepts a `ConsoleAuthorizer` class (built through the container) or a lazy import
of one (`() => import('#policies/console_access')`).

```ts
// config/telescope_ui.ts
export default defineConfig({
  async authorize(ctx) {
    await ctx.auth.check()
    return ctx.auth.user?.role === 'admin'
  },
})
```

Guard outcomes: a bare `false` (or `{ allowed: false }` with no `reason`) → `403`
`{ error: 'forbidden' }`; `{ allowed: false, reason: 'unauthenticated' }` → `401`
`{ error: 'unauthenticated' }`; `{ redirectTo }` → `302` for a page, `401` JSON with
`redirectTo` for the API; a throwing hook → `403`. With tenancy on,
`{ allowed: true, tenants: [...] | '*' }` narrows the viewer to those
organizations (omitted = the viewer's own active tenant).

Source: `docs/dashboard/auth.mdx` (Delegate to your app's auth, Guard behaviour).

### Pattern 2 — send anonymous visitors to the app's login

Return `{ redirectTo }`: a page navigation gets a `302` there, an API call gets
`401 { error: 'unauthenticated', redirectTo }`.

```ts
authorize: (ctx) => {
  if (ctx.auth.user?.isAdmin === true) return true
  return { redirectTo: '/login?next=/telescope' }
}
```

A redirect the hook writes itself also still wins: if it calls
`ctx.response.redirect(...)` and returns `false`, the guard leaves that redirect
alone instead of overwriting it with a `403` body. When the SPA's own API calls get a
`401`, it follows `redirectTo` (or reloads the page).

Source: `docs/dashboard/auth.mdx` (Redirecting instead of answering JSON).

### Pattern 3 — expose the store to coding agents over MCP

With `@adonis-agora/agent/mcp_provider` in the app, Telescope's tools are on `/mcp/agora` with
no config: `telescope_list_entries`, `telescope_get_entry`, `telescope_get_trace`,
`telescope_get_waterfall`, `telescope_get_health`, `telescope_diagnose_exception`. Each call
runs the console's `authorize` (`config/telescope_ui.ts`); with authkit (`mcp: true`) the
client signs in through the browser, with `authorizeByToken` it sends that token.

```sh
claude mcp add --transport http agora http://localhost:3333/mcp/agora
```

Only for clients that can't do OAuth, opt in to the standalone endpoint:

```ts
// config/telescope_mcp.ts
import env from '#start/env'
import { authorizeByToken, defineConfig } from '@adonis-agora/telescope/mcp'

export default defineConfig({
  enabled: true, // off by default: no /telescope/mcp route without it
  authorize: authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') }),
  // tools: ['list_entries', 'get_trace', 'get_health'],    // hand agents a narrower surface
})
```

```sh
claude mcp add --transport http telescope https://your-app.example.com/telescope/mcp \
  --header 'Authorization: Bearer <TELESCOPE_MCP_TOKEN>'
```

Redaction, sampling and tenancy scoping are never bypassed — an agent sees exactly what
the dashboard sees for its granted organizations. Without `authorize` the standalone
endpoint is open outside production and `403` in production (boot warning names
`config/telescope_mcp.ts`); denials are JSON `403 { error: 'forbidden' }` /
`401 { error: 'unauthenticated' }`.

Source: `docs/packages/mcp.mdx`.

### Pattern 4 — gate the dangerous mutations

Replay, CPU-arm and queue retry/enqueue are each disabled by default and answer
`403` until their ui-config gate is flipped — even when the underlying feature is
enabled. With tenancy on, a viewer limited to some organizations still gets `403`
on CPU capture, queue actions, extension actions and Prometheus even when the
gate is on — those reach every organization, so they need access to all of them.

```ts
export default defineConfig({
  replay: { enabled: true },          // POST <path>/api/requests/:id/replay — re-runs a real request!
  cpuProfiling: { armEnabled: true }, // POST <path>/api/profiles/arm
  queueActions: { enabled: true },    // queue console retry/enqueue
})
```

Source: `docs/packages/ui.mdx` (Configuration, Request replay),
`docs/packages/cpu-profiling.mdx` (arming callout).

## Common mistakes

### CRITICAL Relying on an obscure path instead of the guard

```ts
// Wrong — renaming the prefix is not authentication, and without authorize the
// production console answers 403 to everyone:
defineConfig({ path: '/__telescope' })
```

```ts
// Correct — make a deliberate choice for production:
defineConfig({
  path: '/__telescope',
  authorize: (ctx) => ctx.auth.user?.isAdmin === true,
})
```

Mechanism: the default is open outside production and `403` in production; the
boot warning names `config/telescope_ui.ts`.
Source: `docs/dashboard/auth.mdx` (The default policy, Security notes).

### HIGH Keeping the removed `credentials` option on telescope_ui

```ts
// Wrong — 1.0 removed credentials { token, basic } and ?token= from the console.
defineConfig({ credentials: { token: env.get('TELESCOPE_UI_TOKEN') } })
```

```ts
// Correct — Bearer header only.
defineConfig({ authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }) })
```

Mechanism: `credentials` is a type error now and is ignored at runtime, so the production console falls back to
the default `403`. Source: `docs/reference/migrating-to-1-0.mdx`.

### HIGH Expecting `/telescope/mcp` without `enabled: true`

```ts
// Wrong — the standalone endpoint is off by default; this mounts no route.
defineConfig({ authorize: authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') }) })
```

```ts
// Correct — opt in, or point the client at /mcp/agora instead.
defineConfig({
  enabled: true,
  authorize: authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') }),
})
```

Mechanism: `enabled` defaults to `false`; the provider registers no routes and logs nothing.
Source: `docs/packages/mcp.mdx`.

### HIGH Keeping the removed `credentials` option on telescope_mcp

```ts
// Wrong — 1.0 removed credentials { token, basic } and ?token= from the MCP endpoint.
defineConfig({ path: '/telescope/mcp', credentials: { token: env.get('TELESCOPE_MCP_TOKEN') } })
```

```ts
// Correct — the same authorize contract as the console, Bearer header only.
defineConfig({
  enabled: true,
  authorize: authorizeByToken({ token: env.get('TELESCOPE_MCP_TOKEN') }),
})
```

Mechanism: `credentials` is a type error now and is ignored at runtime, so the
production endpoint falls back to the default `403`.
Source: `docs/reference/migrating-to-1-0.mdx`.

### HIGH Keeping the removed `dashboardAuth` login screen

```ts
// Wrong — 1.0 removed dashboardAuth, its login/logout routes and session cookie.
defineConfig({ dashboardAuth: { secret: env.get('TELESCOPE_DASHBOARD_SECRET'), login } })
```

```ts
// Correct — sign in through the app; authorize sends anonymous visitors there.
defineConfig({
  authorize: (ctx) => (ctx.auth.user ? ctx.auth.user.isAdmin === true : { redirectTo: '/login' }),
})
```

Mechanism: `<path>/login` no longer exists; the console only asks `authorize`.
Source: `docs/reference/migrating-to-1-0.mdx`.

See also: `telescope-ui-dashboard/SKILL.md` — the SPA behind these gates;
`telescope-alerts-ai/SKILL.md` — the diagnose route this guard covers.
