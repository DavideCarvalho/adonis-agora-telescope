---
"@adonis-agora/telescope": major
"@adonis-agora/telescope-ui": patch
---

`telescope_ui.authorize` takes the access contract every `@adonis-agora` console shares, in three forms:

- a function, now typed with the real `HttpContext`: `authorize: (ctx) => ctx.auth.user?.isAdmin === true`;
- an authorizer class, built through the container so `@inject()` works: `authorize: ConsoleAccess`;
- a lazy import of that class: `authorize: () => import('#policies/console_access')` (imported once).

It may also return `{ redirectTo: '/login' }`: a page navigation is redirected there (`302`) and an API call gets `401 { error, redirectTo }`. A thrown error is still a `403`. `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` are exported from `@adonis-agora/telescope/ui`.

The default is unchanged: with no `authorize`, the console is open outside production and needs a `credentials` token or Basic pair in production. Existing `authorize` functions and `authorizeByRoles(...)` keep working as they are.

`@adonis-agora/telescope-ui` serves its pages behind the same `authorize`, so the SPA honours every form and `{ redirectTo }` too.
