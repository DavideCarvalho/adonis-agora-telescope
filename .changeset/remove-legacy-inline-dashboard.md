---
"@adonis-agora/telescope": minor
---

Remove `renderDashboard` from `@adonis-agora/telescope/ui`, and the `dashboard.html` it served.

It was the console before `@adonis-agora/telescope-ui` existed: one self-contained page whose whole
UI was an inline `<script>`. Nothing has routed it since the React console replaced it, and it
could not have worked under the CSP a shield-hardened host runs (`script-src 'self' 'nonce-…'`
drops that script whole, leaving a blank page). The docs no longer offer it as a "build your own
UI" option either — that path is the JSON API, which is what the console itself consumes. The
`fillLinkHref` / `tablePagination` helpers it mirrored stay exported.
