---
'@adonis-agora/telescope': minor
---

Diagnostic events about another app, and a server URL found at runtime.

- A diagnostics envelope with `app` (from `@adonis-agora/diagnostics` 1.0.0-rc.6: the tenant app the event is about) records its entry tagged `app:<app>`, so the console's App picker lists that app. On a tenant the tag reaches the server with `tenant.relay: true`, as any relayed entry.
- `tenant.url` and `transports.http({ url })` accept a function, such as `controlPlaneUrl({ issuer, resource: 'urn:agora:telescope' })` from `@adonis-agora/authkit-client`. It is resolved when the first batch is sent (not at boot), kept, and looked up again (its `refresh()` when it has one) when the server cannot be reached or answers 404, retrying the batch at the new URL. `telescope:server:status`, `agora:doctor` (`telescope.server-reachable`) and service discovery resolve it too. Bad strings and anything that is neither a string nor a function are still refused at boot. `httpUrl()` now returns a promise; `httpServer()` returns the shared resolver.
