---
'@adonis-agora/telescope': minor
---

Dashboard `authorize` hook can now return a richer `{ allowed, reason }` decision to get an
exact `401` vs `403`, instead of always falling back to the guard's request-shape heuristic

The guard's `401`-vs-`403` heuristic ("did this request present an `Authorization` header or
`?token=`?") was built for this library's own `credentials: { token, basic }` gate. A host
`authorize` hook authenticating some OTHER way — most commonly a session cookie, e.g.
`@adonis-agora/authz`'s `authorizeByRoles` — is invisible to that heuristic, so BOTH a
genuinely-anonymous request and an authenticated-but-wrong-role request came back `401`, when
the latter should be `403`.

`authorize` may now return `{ allowed: boolean, reason?: 'unauthenticated' | 'forbidden' }`
instead of a bare `boolean`. An explicit `reason` bypasses the request-shape heuristic outright
(`'unauthenticated'` → `401`, `'forbidden'` → `403`); omitting it falls back to the same
heuristic a bare `false` always has. Fully backward compatible — every existing
`(ctx) => boolean` hook keeps behaving byte-for-byte the same.

See the "Bare `boolean` vs the enriched `{ allowed, reason }` return" section of
[Dashboard auth](/docs/telescope/dashboard/auth) for the full `authorizeByRoles` composition
example.
