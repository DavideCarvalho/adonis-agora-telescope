---
"@adonis-agora/telescope-ui": patch
---

Dashboard: survives a nonce CSP.

The provider used to hand the SPA its JSON API base as an inline `<script>` setting
`window.__TELESCOPE_DASHBOARD_BASE__`. A host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
`@nonce`, the recommended setup) drops that script silently; the SPA then derived a base from its own
URL — right for the usual `<mount>/api` layout, but every request 404s on a custom one, from a
console that rendered perfectly well. `injectApiBase` now emits a `<script type="application/json">`
data block, which is never executed and so cannot be refused, and `resolveApiBase` reads it first
(the global is still honoured after it). Nothing to change on the host.
