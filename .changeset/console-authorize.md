---
"@adonis-agora/telescope": major
"@adonis-agora/telescope-ui": major
---

The console has one access option, `telescope_ui.authorize`, shared with every `@adonis-agora` console.

**Breaking: token and HTTP Basic access are removed.** `telescope_ui.credentials` (`{ token, basic }`), the `?token=` query string, the Basic prompt, `defaultAuthorize(...)` and the `UiCredentials` type are gone, so `TELESCOPE_UI_TOKEN` / `TELESCOPE_UI_PASSWORD` are no longer read. For token access use the new helper, which reads only `Authorization: Bearer <token>` (timing-safe) and answers `401` otherwise; an empty or missing token throws when the config loads:

```ts
import { authorizeByToken, defineConfig } from '@adonis-agora/telescope/ui'

export default defineConfig({
  authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
})
```

**Breaking: the default without `authorize`.** The console is open outside production (`app.inProduction === false`); in production every page and API request gets `403`. In every environment, one warning is logged at boot:
`[@adonis-agora/telescope] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in config/telescope_ui.ts.`

**Breaking: denial bodies.** The API answers `403 { error: 'forbidden' }`, `401 { error: 'unauthenticated' }`, and `401 { error: 'unauthenticated', redirectTo }` for `{ redirectTo }`. Pages keep the access-denied page; a `401` no longer sends a `WWW-Authenticate: Basic` challenge (the `challenge` page-guard option is gone).

`authorize` takes three forms:

- a function, typed with the real `HttpContext`: `authorize: (ctx) => ctx.auth.user?.isAdmin === true`;
- an authorizer class, built through the container so `@inject()` works: `authorize: ConsoleAccess`;
- a lazy import of that class: `authorize: () => import('#policies/console_access')` (imported once).

It may return `true`/`false`, `{ allowed, reason? }` or `{ redirectTo: '/login' }` (a page navigation is redirected there with `302`). A thrown error is a `403`. `authorizeByToken`, `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` are exported from `@adonis-agora/telescope/ui`. `authorizeByRoles(...)` keeps working as it is.

`config/telescope_mcp.ts` keeps its own `credentials` gate, unchanged. See the 1.0 migration guide for before/after.

`@adonis-agora/telescope-ui` serves its pages behind the same `authorize`, so the SPA follows the same default and denial handling.
