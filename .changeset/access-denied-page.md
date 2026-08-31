---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": patch
---

Dashboard: a refused page navigation now gets a real page instead of `{"error":"Forbidden"}`.

Opening the `@adonis-agora/telescope-ui` console without permission used to answer the browser
with the same JSON the API gets. It now serves a built-in access-denied page in the console's
own visual language — the status, a sentence explaining the refusal, a "Back to app" link and,
when `dashboardAuth` is configured, a "Sign in" button. Statuses are unchanged (a `401` still
carries `WWW-Authenticate`, so the built-in `basic` credentials keep prompting natively), API
requests are unchanged, and an `authorize` hook that redirects still wins.

The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
`<style>` takes `@adonisjs/shield`'s request nonce when one exists.

New `accessDenied` option on `config/telescope_ui.ts` to customise it — an object (`brand`,
`title`, `message`, `homeHref`, `loginHref`, `accent`, labels) to tweak the built-in page, or a
function `(info, ctx) => html | void` to render it yourself or redirect. Core exports the new
`enforcePageGuard` + `renderAccessDeniedPage` for hosts serving the SPA themselves;
`@adonis-agora/telescope-ui` now needs `@adonis-agora/telescope >= 0.11.0` for it.

Also: the built-in `dashboardAuth` login page no longer dies under a nonce'd CSP. It is now a real
HTML form that works without JavaScript — a form submit is answered with a redirect (to the page
the operator came from, or back to the form with the error shown) while the page's own `fetch`
keeps getting JSON — and its inline script/style carry `@adonisjs/shield`'s request nonce.
`renderLoginPage` takes an optional `{ nonce, error, returnTo }`. And the SPA's `401` page sends
the `WWW-Authenticate: Basic` challenge only when `credentials.basic` is configured
(`PageGuardOptions.challenge`), so hosts gating on their own `authorize` no longer get a native
browser prompt over it.
