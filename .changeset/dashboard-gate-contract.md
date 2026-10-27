---
"@adonis-agora/telescope": minor
---

Dashboard gate: a custom `authorize` hook returning a bare `false` is now a `403`, not a guessed `401`.

The guard used to turn a bare `false` (or `{ allowed: false }` with no `reason`) into `401 — Sign in required` whenever the request carried no `Authorization` header / `?token`. That heuristic was built for the built-in `credentials: { token, basic }` gate, but it also fired for custom hooks that authenticate via a session cookie (e.g. `@adonis-agora/authz`'s `authorizeByRoles`), so a signed-in user without the right role was told to sign in instead of getting `403`.

Telescope now follows the same dashboard-gate contract as every `@adonis-agora` console:

- `true` / `{ allowed: true }` → proceed.
- `{ allowed: false, reason: 'unauthenticated' }` → `401`; `reason: 'forbidden'` → `403`.
- bare `false` / `{ allowed: false }` without a `reason` → `403` (fail closed); a throwing hook → `403`.
- a redirect (or body) the hook already wrote still wins; pages get the access-denied HTML, the API gets JSON.

The built-in gate (no custom `authorize`, or `authorize: defaultAuthorize(...)`, in both `telescope_ui` and `telescope_mcp` configs) keeps its behavior: `401` + `WWW-Authenticate` when no credential was presented, `403` when one was presented but rejected. The exported `defaultAuthorize()` still returns a plain `boolean`.

**Migration:** if your custom hook relied on the `401` for anonymous visitors, return `{ allowed: false, reason: 'unauthenticated' }` for that case.
