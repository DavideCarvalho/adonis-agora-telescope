---
'@adonis-agora/telescope-ui': patch
---

Console footer: the signed-in user's role now shows when no `viewer` hook is set. The structural read of `ctx.auth.user` takes `role`, `roles` (strings, `{ name }` or authz `{ role }` rows) and `globalRoles`, plus the global roles of authkit's per-request identity on `ctx.authkit` (read structurally, 250 ms cap). One role is shown: an admin-like one first, else the first.

Console: inline SVG favicon in the console accent, so the browser no longer probes `/favicon.ico` and logs a 404 in the host app.

Overview: the "Failed jobs" tile no longer sits on its skeleton when no queue manager is configured (it says "not measured") or when `/queues/live` fails.
