---
name: telescope-access-mcp
description: >-
  Dashboard access control and the MCP endpoint in @adonis-agora/telescope —
  config/telescope_ui.ts authorize(ctx) hook vs credentials { token, basic },
  dashboardAuth { secret, ttl, login } login screen, defaultAuthorize (allow outside
  production, deny in production), 401-vs-403 fail-closed guard semantics,
  redirect-wins behaviour, replay/queueActions/cpuProfiling.armEnabled mutation
  gates, and config/telescope_mcp.ts JSON-RPC tools behind the same guard. Use for
  "lock down the dashboard", "dashboard open in production", "401 on /telescope",
  "login wall", "expose telescope to Claude Code", "replay returns 403".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "0.8.4"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/dashboard/auth.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/mcp.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/ui.mdx"
---

# Dashboard access control & MCP

Every route serving recorded data runs an `authorize` guard first — every
`<path>/api/*` endpoint, the SSE stream, metrics and the SPA routes. Out of the box
the policy is **allow outside production, deny in production** until a credential or
hook permits it. The MCP subpath reuses exactly the same guard.

## Setup

The simplest production gate is a built-in credential; either `token` or `basic`,
or both:

```ts
// config/telescope_ui.ts
import env from '#start/env'
import { defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  enabled: true,
  path: '/telescope',
  credentials: { token: env.get('TELESCOPE_UI_TOKEN') },
})
```

```sh
curl -H 'Authorization: Bearer s3cr3t' http://localhost:3333/telescope/api/entries
open 'http://localhost:3333/telescope?token=s3cr3t'   # ?token= is convenient but leaky
```

Source: `docs/dashboard/auth.mdx` (Built-in credentials).

## Core patterns

### Pattern 1 — delegate to your app's auth

When you set `authorize`, the built-in `credentials` gate is ignored — your hook IS
the whole policy. It receives your **real** `HttpContext` through a framework-light
declared type, so narrow it to reach `auth`/`session` at runtime.

```ts
// config/telescope_ui.ts
export default defineConfig({
  async authorize(ctx) {
    const { auth } = ctx as unknown as {
      auth: { check(): Promise<boolean>; user?: { role?: string } }
    }
    await auth.check()
    return auth.user?.role === 'admin'
  },
})
```

Guard outcomes: denied with no credential → `401` (+ `WWW-Authenticate`); denied
with a rejected credential → `403`; a throwing hook → `403` (fail-closed).

Source: `docs/dashboard/auth.mdx` (Delegate to your app's auth, Guard behaviour).

### Pattern 2 — a real login wall with dashboardAuth

For shared human access: a server-rendered login page plus a signed session cookie.
It composes WITH `authorize` (both must pass). Missing `secret` or `login` throws at
boot rather than shipping an un-mintable gate.

```ts
// config/telescope_ui.ts
import env from '#start/env'
import User from '#models/user'
import hash from '@adonisjs/core/services/hash'
import { defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  dashboardAuth: {
    secret: env.get('TELESCOPE_DASHBOARD_SECRET'),   // HMAC-SHA256 key, 32+ bytes — required
    ttl: '8h',
    async login(username, password) {
      const user = await User.findBy('email', username)
      if (!user || !(await hash.verify(user.password, password))) return null
      if (!user.isAdmin) return null
      return { id: String(user.id), name: user.fullName }   // session user, or null to deny
    },
  },
})
```

This mounts unguarded-by-necessity `GET/POST <path>/login` and `GET <path>/logout`
routes (they mint/clear the session only — no recorded data sits behind them).
An unauthenticated page navigation gets a `302` to the login; an unauthenticated API
call gets a plain `401`.

Source: `docs/dashboard/auth.mdx` (Built-in login screen).

### Pattern 3 — redirect instead of answering JSON

If the hook sets a `location` header and then returns `false`, the guard leaves the
redirect alone instead of overwriting it with a `403` body.

```ts
authorize: (ctx) => {
  const { auth } = ctx as unknown as { auth: { user?: { isAdmin?: boolean } } }
  if (auth.user?.isAdmin === true) return true
  ctx.response.redirect('/login?next=/telescope')
  return false   // redirect wins only when the hook returns false
}
```

Source: `docs/dashboard/auth.mdx` (Redirecting instead of answering JSON).

### Pattern 4 — expose the store to coding agents over MCP

```ts
// config/telescope_mcp.ts
import env from '#start/env'
import { defineConfig } from '@adonis-agora/telescope/mcp'

export default defineConfig({
  enabled: true,
  path: '/telescope/mcp',
  credentials: { token: env.get('TELESCOPE_MCP_TOKEN') },   // same guard as the dashboard
  // tools: ['list_entries', 'get_trace', 'get_health'],    // hand agents a narrower surface
})
```

```sh
claude mcp add --transport http telescope https://your-app.example.com/telescope/mcp \
  --header 'Authorization: Bearer <TELESCOPE_MCP_TOKEN>'
```

Six read tools ship: `list_entries`, `get_entry`, `get_trace`, `get_waterfall`,
`get_health`, `diagnose_exception`. Redaction and sampling are never bypassed — an
agent sees exactly what the dashboard sees.

Source: `docs/packages/mcp.mdx`.

### Pattern 5 — gate the dangerous mutations

Replay, CPU-arm and queue retry/enqueue are each disabled by default and answer
`403` until their ui-config gate is flipped — even when the underlying feature is
enabled.

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
// Wrong — renaming the prefix is defense in depth, not authentication:
defineConfig({ path: '/__telescope' })   // production: denied anyway without a credential/hook
```

```ts
// Correct — make a deliberate choice for production:
defineConfig({
  path: '/__telescope',
  credentials: { token: env.get('TELESCOPE_UI_TOKEN') },
})
```

Mechanism: the default policy denies production until a credential or `authorize`
hook permits it — but that deny is the *default*, never a guarantee you can skip
configuring; security notes call this out explicitly.
Source: `docs/dashboard/auth.mdx` (default policy warn + Security notes).

### MEDIUM Setting credentials AND an authorize hook expecting both to run

```ts
// Wrong — the token gate silently stops mattering once authorize is set.
defineConfig({
  credentials: { token: env.get('TELESCOPE_UI_TOKEN') },
  authorize: () => true,   // now the whole policy; credentials ignored
})
```

```ts
// Correct — pick one: credentials for simple gates, authorize for real policies.
defineConfig({ credentials: { basic: { username: 'admin', password: env.get('TELESCOPE_UI_PASSWORD') } } })
```

Mechanism: the docs state the built-in `credentials` gate is ignored whenever
`authorize` is set — your hook replaces it entirely (`dashboardAuth`, by contrast,
composes with `authorize`).
Source: `docs/dashboard/auth.mdx` (Delegate to your app's auth).

### MEDIUM Reaching for ctx.auth without narrowing the context

```ts
// Wrong — does not type-check: the declared parameter is a minimal HTTP slice.
authorize: (ctx) => ctx.auth.user?.isAdmin === true
```

```ts
// Correct — narrow to the slice you rely on; the REAL HttpContext passes through.
authorize: (ctx) => {
  const { auth } = ctx as unknown as { auth: { user?: { isAdmin?: boolean } } }
  return auth.user?.isAdmin === true
}
```

Mechanism: the guard's declared shape is framework-light (`request.qs()`,
`request.header()`, `response`) so any server can satisfy it; `auth`/`session`
exist at runtime only after narrowing.
Source: `docs/dashboard/auth.mdx` (narrowing info callout).

### HIGH Exposing MCP in production without a token credential

```ts
// Wrong — relies on the dev-open default; prod denials surface as opaque JSON-RPC errors.
defineConfig({ enabled: true, path: '/telescope/mcp' })
```

```ts
// Correct — a token/basic credential for production.
defineConfig({
  path: '/telescope/mcp',
  credentials: { token: env.get('TELESCOPE_MCP_TOKEN') },
})
```

Mechanism: MCP has no transport-level 401 — denial rides inside the JSON-RPC
envelope as `-32001` (`MCP_UNAUTHORIZED`), which compliant clients just report as a
failed call.
Source: `docs/packages/mcp.mdx` (guard info callout).

### MEDIUM Configuring dashboardAuth without secret or login

```ts
// Wrong — both keys are required; this throws at boot.
defineConfig({ dashboardAuth: { secret: env.get('TELESCOPE_DASHBOARD_SECRET') } })
defineConfig({ dashboardAuth: { login: verifyCreds } })
```

```ts
// Correct — non-empty secret AND a login hook.
defineConfig({
  dashboardAuth: {
    secret: env.get('TELESCOPE_DASHBOARD_SECRET'),
    ttl: '8h',
    login: verifyCreds,
  },
})
```

Mechanism: the cookie can never be minted without a signing key and a validator, so
the config fails closed at startup rather than shipping an un-loginable wall.
Source: `docs/dashboard/auth.mdx` (Built-in login screen table + warn callout).

See also: `telescope-ui-dashboard/SKILL.md` — the SPA behind these gates;
`telescope-alerts-ai/SKILL.md` — the diagnose route this guard covers.
